// Genetic algorithm that evolves a population of neural-net drivers.

import { NeuralNet, gaussian, resetGaussian } from './nn.js';
import { Car, INPUT_SIZE, BASE_INPUT_SIZE, OLD_INPUT_SIZES, OUTPUT_SIZE } from './car.js';
import { PoliceForce } from './police.js';
import { resetObstacles } from './obstacles.js';
import { random, seedRandom } from './rng.js';

export const DEFAULT_SETTINGS = {
  populationSize: 50,
  hidden: [12, 8],
  elites: 3,              // minimum number of unchanged survivors
  eliteFraction: 0.1,     // ...or this share of the population, whichever is larger
  crossoverRate: 0.3,
  initScale: 0.4,         // new brains start timid, so skill has to be learned rather than lucked into
  roadAhead: true,        // cars sense which way the road goes ahead
  fineTuneShare: 0.6,     // share of children that only get tiny mutations
  fineTuneScale: 0.12,
  mutationRate: 0.08,     // chance each weight is mutated
  mutationStrength: 0.35, // std-dev of gaussian nudge
  tournament: 4,
  police: 0,              // number of police cars hunting the racers
  seeded: true,           // repeatable runs: the same seed always plays out the same way
  seed: 1,
};

export const DT = 1 / 60;

export class Evolution {
  constructor(track, settings = {}, seedGenome = null, policeGenomes = null) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    // every new run starts the random numbers from its seed (or truly random if switched off)
    seedRandom(this.settings.seeded !== false ? this.settings.seed : null);
    resetGaussian();
    this.layers = [INPUT_SIZE, ...this.settings.hidden, OUTPUT_SIZE];
    seedGenome = upgradeGenome(seedGenome, this.layers);
    this.track = track;
    this.generation = 1;
    this.history = [];          // per-generation stats
    this.bestLap = null;        // best lap time ever (s)
    this.bestGenome = null;     // genome that set it (or best fitness so far)
    this.bestFitness = -Infinity;
    this.stagnation = 0;
    this.time = 0;

    resetObstacles(track.obstacles);
    const n = this.settings.populationSize;
    const genomes = [];
    for (let i = 0; i < n; i++) {
      if (seedGenome && seedGenome.length === NeuralNet.genomeSize(this.layers)) {
        const g = Float32Array.from(seedGenome);
        if (i > 0) this.mutate(g, 0.15, 0.3);
        genomes.push(g);
      } else genomes.push(null);
    }
    // which genome entries are the police-radar weights (first layer, radar inputs)
    const nIn = this.layers[0];
    this.radarIdx = [];
    for (let j = 0; j < this.layers[1]; j++) for (let i = BASE_INPUT_SIZE; i < nIn; i++) this.radarIdx.push(j * (nIn + 1) + i);
    this.cars = genomes.map(g => {
      if (!g) { g = NeuralNet.randomGenome(this.layers, this.settings.initScale); for (const k of this.radarIdx) g[k] = 0; }
      return new Car(new NeuralNet(this.layers, g), track, { roadAhead: this.settings.roadAhead });
    });
    this.police = new PoliceForce(track, this.settings.police || 0, policeGenomes);
    this.linkPolice();
    this.parkPoliceIfWaiting();
  }

  /**
   * Police join once the racers can finish reliably (a generation where at least
   * 10 % of the cars, and at least 5, finished) – first the racers learn the track, then the chase begins.
   */
  get policeActive() { return !!this.policeOn; }
  parkPoliceIfWaiting() { if (!this.policeActive) this.police.park(); }
  /** After loading a saved run (bestLap restored): put the police on track if they should be. */
  syncPolice() {
    if (this.policeActive) {
      if (this.police.cars.some(c => c.parked)) this.police.resetAll();
      this.policeWasActive = true;
      this.policeOnDuty = Math.max(1, Math.min(this.police.cars.length, this.policeOnDuty || Math.ceil(this.police.cars.length / 3)));
      this.police.applyDuty(this.policeOnDuty);
    }
    else this.police.park();
  }

  /**
   * How many police are on duty adapts to how the racers cope: a third of them (at least one)
   * start when the police join; one more joins after each generation where enough racers still
   * finish, and one goes off duty after 3 generations in a row with no finishers. So the
   * pressure keeps rising as the racers improve, without wiping them out.
   */
  updatePoliceDuty(finishers) {
    const n = this.police.cars.length, pop = this.cars.length;
    if (!n) return;
    if (!this.policeOn) {
      if (finishers >= Math.max(5, 0.1 * pop)) { this.policeOn = true; this.policeOnDuty = Math.max(1, Math.ceil(n / 3)); this.policeDrought = 0; }
    } else {
      if (finishers >= Math.max(3, 0.06 * pop)) { this.policeOnDuty = Math.min(n, (this.policeOnDuty || 1) + 1); this.policeDrought = 0; }
      else if (finishers === 0 && ++this.policeDrought >= 3) { this.policeOnDuty = Math.max(1, (this.policeOnDuty || 1) - 1); this.policeDrought = 0; }
    }
    if (this.policeOn) this.police.applyDuty(this.policeOnDuty || n);
  }

  linkPolice() {
    const list = this.police.cars.length ? this.police.cars : null;
    for (const c of this.cars) c.police = list;
    this.police.setRacers(this.cars);
  }

  /** Change how many police cars there are (keeps their brains). */
  setPoliceCount(n) {
    this.settings.police = n;
    this.police.resize(n);
    this.linkPolice();
    this.syncPolice();
  }

  /** Cars still trying to finish their lap (finished cars drive on for show). */
  get aliveCount() { let c = 0; for (const car of this.cars) if (car.racing) c++; return c; }

  /** Time limit for the current generation. */
  get timeLimit() {
    if (this.bestLap) return this.bestLap * 1.25 + 3;
    return Math.min(180 * this.track.laps, 20 + this.track.raceLength / 10);
  }

  /** The car currently furthest along (alive preferred). */
  leader() {
    let best = null, bp = -Infinity;
    for (const c of this.cars) {
      // follow the best car still racing; once all are done, the fastest finisher
      const p = c.racing ? 1e6 + c.maxProgress + c.progress * 1e-3 : c.finished ? (c.alive ? 5e5 : 4e5) - c.lapTime : c.maxProgress;
      if (p > bp) { bp = p; best = c; }
    }
    return best;
  }

  /** Advance the whole population one physics step. Returns true if the generation ended. */
  step() {
    this.time += DT;
    let alive = 0;
    for (const c of this.cars) c.step(DT);
    if (this.police.cars.length && this.policeActive) this.police.step(DT, this.cars);
    for (const c of this.cars) if (c.racing) alive++;
    if (alive === 0 || this.time >= this.timeLimit) { this.nextGeneration(); return true; }
    return false;
  }

  nextGeneration() {
    const S = this.settings;
    for (const c of this.cars) c.computeFitness();
    const sorted = this.cars.slice().sort((a, b) => b.fitness - a.fitness);
    const best = sorted[0];

    const finishers = sorted.filter(c => c.finished);
    const genBestLap = finishers.length ? Math.min(...finishers.map(c => c.lapTime)) : null;
    const avgFitness = sorted.reduce((s, c) => s + c.fitness, 0) / sorted.length;
    const stats = {
      generation: this.generation,
      bestFitness: best.fitness,
      avgFitness,
      bestProgress: Math.min(1, best.maxProgress / this.track.raceLength),
      bestLap: genBestLap,
      finishers: finishers.length,
      busted: sorted.filter(c => c.busted).length,
    };
    this.history.push(stats);
    // why each car's run ended (for the developer menu)
    stats.outcomes = {};
    for (const c of this.cars) { const k = c.finished ? 'finished' : c.killedBy || 'time up'; stats.outcomes[k] = (stats.outcomes[k] || 0) + 1; }
    this.lastStats = stats;

    if (genBestLap && (!this.bestLap || genBestLap < this.bestLap)) this.bestLap = genBestLap;
    if (best.fitness > this.bestFitness + 1e-4) {
      this.bestFitness = best.fitness;
      this.bestGenome = Float32Array.from(best.brain.genome);
      this.stagnation = 0;
    } else this.stagnation++;

    // Next generation. Most children are small tweaks of good drivers, so the
    // whole field stays competent; only a few explore with big mutations
    // (and those get bigger the longer progress has stalled).
    const boost = 1 + Math.min(2, this.stagnation / 8);
    const nElite = Math.min(sorted.length, Math.max(S.elites, Math.round(S.populationSize * S.eliteFraction)));
    const next = [];
    if (this.bestGenome) next.push(Float32Array.from(this.bestGenome)); // best ever always survives
    for (let i = 0; next.length < nElite; i++) next.push(Float32Array.from(sorted[i].brain.genome));
    this.eliteCount = next.length;
    while (next.length < S.populationSize) {
      const a = this.tournamentPick(sorted);
      const child = random() < S.crossoverRate
        ? crossover(a.brain.genome, this.tournamentPick(sorted).brain.genome)
        : Float32Array.from(a.brain.genome);
      // Until someone can finish a lap, explore more; afterwards mostly refine
      const share = this.bestLap ? S.fineTuneShare : S.fineTuneShare * 0.6;
      const scale = this.bestLap ? S.fineTuneScale : S.fineTuneScale * 2.5;
      const r = random();
      if (r < share) this.mutate(child, S.mutationRate * scale, S.mutationStrength * scale); // fine-tune
      else if (r < share + (1 - share) * 0.7) this.mutate(child, S.mutationRate, S.mutationStrength); // normal
      else this.mutate(child, S.mutationRate * boost, S.mutationStrength * boost * 1.5); // explore
      next.push(child);
    }

    if (this.policeWasActive) this.police.nextGeneration(); // (no police evolution while they wait)
    else this.police.resetAll();
    resetObstacles(this.track.obstacles); // smashed crates are rebuilt for the next generation
    this.cars.forEach((car, i) => {
      car.brain.genome = next[i];
      car.isElite = i < this.eliteCount;
      car.reset();
    });
    this.generation++;
    this.time = 0;
    this.updatePoliceDuty(finishers.length);
    this.policeWasActive = this.policeActive;
    this.parkPoliceIfWaiting();
  }

  tournamentPick(sorted) {
    let best = null;
    for (let i = 0; i < this.settings.tournament; i++) {
      const c = sorted[Math.floor(random() * sorted.length)];
      if (!best || c.fitness > best.fitness) best = c;
    }
    return best;
  }

  mutate(g, rate, strength) {
    for (let i = 0; i < g.length; i++) {
      if (random() < rate) {
        if (random() < 0.05) g[i] = gaussian();        // occasional reset
        else g[i] += gaussian() * strength;
      }
    }
    // Until police are on the track the radar inputs are always 0, so evolution can't tell good
    // radar weights from bad: keep them at 0 rather than letting them drift at random – otherwise
    // the moment police appear, those random weights take over the steering and the racers freeze.
    if (!this.policeActive && this.radarIdx) for (const k of this.radarIdx) g[k] = 0;
  }

  /** Run until the current generation ends (headless). */
  runGeneration(maxSteps = 1e6) {
    for (let i = 0; i < maxSteps; i++) if (this.step()) return this.lastStats;
    return null;
  }
}

/**
 * Brains saved with fewer inputs (before police, or before the police radar) keep their
 * driving inputs; the police inputs start with zero weight (same driving without police).
 */
export function upgradeGenome(g, layers) {
  if (!g) return g;
  const size = NeuralNet.genomeSize(layers);
  if (g.length === size) return g;
  const oldIn = OLD_INPUT_SIZES.find(n => g.length === NeuralNet.genomeSize([n, ...layers.slice(1)]));
  if (!oldIn) return g;
  const out = new Float32Array(size), nIn = layers[0];
  let o = 0, p = 0;
  for (let j = 0; j < layers[1]; j++) {
    for (let i = 0; i < BASE_INPUT_SIZE; i++) out[p++] = g[o++];  // driving inputs
    o += oldIn - BASE_INPUT_SIZE;                                  // old police inputs: dropped
    p += nIn - BASE_INPUT_SIZE;                                    // radar inputs: zero weight
    out[p++] = g[o++]; // bias
  }
  while (o < g.length) out[p++] = g[o++];
  return out;
}

function crossover(a, b) {
  // Layer-agnostic two-point crossover keeps chunks of neighbouring weights together
  const n = a.length, child = new Float32Array(n);
  let p1 = Math.floor(random() * n), p2 = Math.floor(random() * n);
  if (p1 > p2) [p1, p2] = [p2, p1];
  for (let i = 0; i < n; i++) child[i] = i >= p1 && i < p2 ? b[i] : a[i];
  return child;
}
