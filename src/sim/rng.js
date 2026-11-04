// The simulation's single source of randomness. With a seed set, every run of the
// same track + settings + seed plays out exactly the same (same brains, same
// mutations, same results), so a problem seen at "seed 1234, generation 37" can be
// reproduced. Without a seed it falls back to Math.random.

let seeded = false, state = 0;

/** mulberry32: small, fast, good enough for a genetic algorithm */
function next() {
  state = (state + 0x6D2B79F5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function random() { return seeded ? next() : Math.random(); }

/** seed = a number → repeatable; null/undefined → truly random */
export function seedRandom(seed) {
  seeded = seed !== null && seed !== undefined && Number.isFinite(Number(seed));
  state = seeded ? (Number(seed) >>> 0) ^ 0x9E3779B9 : 0;
}

export function rngState() { return seeded ? state : null; }
export function setRngState(s) { if (s !== null && s !== undefined) { seeded = true; state = s | 0; } }
export function isSeeded() { return seeded; }
export function newSeed() { return Math.floor(Math.random() * 1e6); }
