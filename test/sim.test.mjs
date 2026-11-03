// Headless check that the AI actually learns: run generations on each preset
// track and verify that cars finish laps.
import { Track, PRESETS } from '../src/sim/track.js';
import { Evolution } from '../src/sim/evolution.js';
import { TILE_PRESETS, traceLayout } from '../src/sim/tiles.js';

const GENS = Number(process.env.GENS || 60);
let failed = false;

export function presetTrack(name) {
  if (PRESETS[name]) return Track.fromLoop(PRESETS[name].points, PRESETS[name].width);
  const p = TILE_PRESETS[name.replace(/^Tiles:/, '')];
  const res = traceLayout(p.tiles());
  if (!res.ok) throw new Error(name + ': ' + res.error.msg);
  return new Track(res.net, p.width);
}

const names = [...Object.keys(PRESETS), ...Object.keys(TILE_PRESETS).map(n => 'Tiles:' + n)];
const filter = process.env.PRESET_FILTER ? process.env.PRESET_FILTER.split(',') : null;
for (const name of names) {
  if (filter && !filter.includes(name)) continue;
  const track = presetTrack(name);
  const evo = new Evolution(track);
  const t0 = performance.now();
  let firstLap = null, firstLapGen = null;
  for (let g = 0; g < GENS; g++) {
    const s = evo.runGeneration();
    if (s.bestLap && !firstLap) { firstLap = s.bestLap; firstLapGen = s.generation; }
  }
  const ms = performance.now() - t0;
  const last = evo.history.slice(-5);
  console.log(`${name.padEnd(22)} lap=${track.lapLength.toFixed(0)}m  ` +
    `first lap: ${firstLap ? firstLap.toFixed(2) + 's @gen ' + firstLapGen : 'none'}  ` +
    `best lap: ${evo.bestLap ? evo.bestLap.toFixed(2) + 's' : 'none'}  ` +
    `finishers(last 5 gens)=${last.map(h => h.finishers).join(',')}/${evo.cars.length}  (${(ms / 1000).toFixed(1)}s)`);
  if (!evo.bestLap) failed = true;
}

if (failed) { console.error('FAIL: some track was never completed'); process.exit(1); }
console.log('OK');
