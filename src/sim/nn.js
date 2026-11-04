// Tiny feed-forward neural network. The genome is a flat Float32Array of all
// weights and biases, which is what the genetic algorithm evolves.

import { random } from './rng.js';

export class NeuralNet {
  /** @param {number[]} layers e.g. [11, 12, 8, 2] */
  constructor(layers, genome = null) {
    this.layers = layers.slice();
    this.size = NeuralNet.genomeSize(layers);
    this.genome = genome ? Float32Array.from(genome) : NeuralNet.randomGenome(layers);
    // Activation buffers (kept for visualisation)
    this.activations = layers.map(n => new Float32Array(n));
  }

  static genomeSize(layers) {
    let s = 0;
    for (let l = 1; l < layers.length; l++) s += layers[l] * (layers[l - 1] + 1);
    return s;
  }

  /** @param scale how strong the random starting connections are (1.5 = bold, ~0.3 = timid) */
  static randomGenome(layers, scale0 = 1.5) {
    const g = new Float32Array(NeuralNet.genomeSize(layers));
    let o = 0;
    for (let l = 1; l < layers.length; l++) {
      const fanIn = layers[l - 1] + 1;
      const scale = 1 / Math.sqrt(fanIn);
      for (let k = 0; k < layers[l] * fanIn; k++) g[o++] = gaussian() * scale * scale0;
    }
    return g;
  }

  /** Forward pass with tanh on every layer. Returns the output activations. */
  forward(input) {
    const acts = this.activations, g = this.genome, L = this.layers;
    const a0 = acts[0];
    for (let i = 0; i < L[0]; i++) a0[i] = input[i];
    let o = 0;
    for (let l = 1; l < L.length; l++) {
      const prev = acts[l - 1], cur = acts[l], nIn = L[l - 1];
      for (let j = 0; j < L[l]; j++) {
        let s = 0;
        for (let i = 0; i < nIn; i++) s += prev[i] * g[o++];
        s += g[o++]; // bias
        cur[j] = Math.tanh(s);
      }
    }
    return acts[L.length - 1];
  }

  /** Iterate over weights for drawing: cb(layer, from, to, weight) */
  forEachWeight(cb) {
    const g = this.genome, L = this.layers;
    let o = 0;
    for (let l = 1; l < L.length; l++) {
      for (let j = 0; j < L[l]; j++) {
        for (let i = 0; i < L[l - 1]; i++) cb(l, i, j, g[o++]);
        o++; // bias
      }
    }
  }
}

let spare = null;
/** forget the cached second value (called when a run is seeded, so it starts clean) */
export function resetGaussian() { spare = null; }
export function gaussianSpare() { return spare; }
export function setGaussianSpare(v) { spare = v ?? null; }
export function gaussian() {
  if (spare !== null) { const s = spare; spare = null; return s; }
  let u, v, s;
  do { u = random() * 2 - 1; v = random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s);
  spare = v * m;
  return u * m;
}
