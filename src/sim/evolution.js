// Genetic algorithm that evolves a population of neural-net drivers.

import { NeuralNet, gaussian } from './nn.js';
import { Car, INPUT_SIZE, OUTPUT_SIZE } from './car.js';

export const DEFAULT_SETTINGS = {
  populationSize: 50,
  hidden: [12, 8],
  elites: 3,              // minimum number of unchanged survivors
  eliteFraction: 0.1,     // ...or this share of the population, whichever is larger
  crossoverRate: 0.3,
  fineTuneShare: 0.6,     // share of children that only get tiny mutations
  fineTuneScale: 0.12,
  mutationRate: 0.08,     // chance each weight is mutated
  mutationStrength: 0.35, // std-dev of gaussian nudge
  tournament: 4,
};

export const DT = 1 / 60;

export class Evolution {
  constructor(track, settings = {}, seedGenome = null) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.layers = [INPUT_SIZE, ...this.settings.hidden, OUTPUT_SIZE];
    this.track = track;
    this.generation = 1;
    this.history = [];          // per-generation stats
    this.bestLap = null;        // best lap time ever (s)
    this.bestGenome = null;     // genome that set it (or best fitness so far)
    this.bestFitness = -Infinity;
    this.stagnation = 0;
    this.time = 0;

    const n = this.settings.populationSize;
    const genomes = [];
    for (let i = 0; i < n; i++) {
      if (seedGenome && seedGenome.length === NeuralNet.genomeSize(this.layers)) {
        const g = Float32Array.from(seedGenome);
        if (i > 0) this.mutate(g, 0.15, 0.3);
        genomes.push(g);
      } else genomes.push(null);
    }
    this.cars = genomes.map(g => new Car(new NeuralNet(this.layers, g), track));
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
    for (const c of this.cars) { c.step(DT); if (c.racing) alive++; }
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
    };
    this.history.push(stats);
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
      const child = Math.random() < S.crossoverRate
        ? crossover(a.brain.genome, this.tournamentPick(sorted).brain.genome)
        : Float32Array.from(a.brain.genome);
      // Until someone can finish a lap, explore more; afterwards mostly refine
      const share = this.bestLap ? S.fineTuneShare : S.fineTuneShare * 0.6;
      const scale = this.bestLap ? S.fineTuneScale : S.fineTuneScale * 2.5;
      const r = Math.random();
      if (r < share) this.mutate(child, S.mutationRate * scale, S.mutationStrength * scale); // fine-tune
      else if (r < share + (1 - share) * 0.7) this.mutate(child, S.mutationRate, S.mutationStrength); // normal
      else this.mutate(child, S.mutationRate * boost, S.mutationStrength * boost * 1.5); // explore
      next.push(child);
    }

    this.cars.forEach((car, i) => {
      car.brain.genome = next[i];
      car.isElite = i < this.eliteCount;
      car.reset();
    });
    this.generation++;
    this.time = 0;
  }

  tournamentPick(sorted) {
    let best = null;
    for (let i = 0; i < this.settings.tournament; i++) {
      const c = sorted[Math.floor(Math.random() * sorted.length)];
      if (!best || c.fitness > best.fitness) best = c;
    }
    return best;
  }

  mutate(g, rate, strength) {
    for (let i = 0; i < g.length; i++) {
      if (Math.random() < rate) {
        if (Math.random() < 0.05) g[i] = gaussian();        // occasional reset
        else g[i] += gaussian() * strength;
      }
    }
  }

  /** Run until the current generation ends (headless). */
  runGeneration(maxSteps = 1e6) {
    for (let i = 0; i < maxSteps; i++) if (this.step()) return this.lastStats;
    return null;
  }
}

function crossover(a, b) {
  // Layer-agnostic two-point crossover keeps chunks of neighbouring weights together
  const n = a.length, child = new Float32Array(n);
  let p1 = Math.floor(Math.random() * n), p2 = Math.floor(Math.random() * n);
  if (p1 > p2) [p1, p2] = [p2, p1];
  for (let i = 0; i < n; i++) child[i] = i >= p1 && i < p2 ? b[i] : a[i];
  return child;
}
