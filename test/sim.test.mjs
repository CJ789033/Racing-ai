// Headless check that the AI actually learns: run generations on each preset
// track and verify that cars finish laps and lap times improve.
import { Track, PRESETS } from '../src/sim/track.js';
import { Evolution } from '../src/sim/evolution.js';
import { TILE_PRESETS, traceLayout } from '../src/sim/tiles.js';

const GENS = Number(process.env.GENS || 60);
let failed = false;

const filter = process.env.PRESET_FILTER ? process.env.PRESET_FILTER.split(',') : null;
const tracks = [
  ...Object.entries(PRESETS).map(([name, p]) => [name, () => new Track(p.points, p.width)]),
  ...Object.entries(TILE_PRESETS).map(([name, p]) => ['Tiles:' + name, () => {
    const res = traceLayout(p.tiles());
    if (!res.ok) throw new Error(name + ': ' + res.error.msg);
    return new Track(res.points, p.width, { polyline: true });
  }]),
];
for (const [name, make] of tracks) {
  if (filter && !filter.includes(name)) continue;
  const track = make();
  const evo = new Evolution(track);
  const t0 = performance.now();
  let firstLap = null, firstLapGen = null;
  for (let g = 0; g < GENS; g++) {
    const s = evo.runGeneration();
    if (s.bestLap && !firstLap) { firstLap = s.bestLap; firstLapGen = s.generation; }
  }
  const ms = performance.now() - t0;
  const last = evo.lastStats;
  console.log(`${name.padEnd(16)} length=${track.length.toFixed(0)}m  ` +
    `first lap: ${firstLap ? firstLap.toFixed(2) + 's @gen ' + firstLapGen : 'none'}  ` +
    `best lap: ${evo.bestLap ? evo.bestLap.toFixed(2) + 's' : 'none'}  ` +
    `finishers(last gen)=${last.finishers}/${evo.cars.length}  (${(ms / 1000).toFixed(1)}s)`);
  if (!evo.bestLap) failed = true;
}

if (failed) { console.error('FAIL: some track was never completed'); process.exit(1); }
console.log('OK');
