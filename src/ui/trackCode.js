// Track codes: a whole track as one line of text, to send to a friend or paste into a
// bug report. "RAI1." = compressed (deflate), "RAI0." = plain (browsers without
// compression support). Both decode everywhere that supports them.

const toB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const fromB64 = str => { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
const canCompress = typeof CompressionStream !== 'undefined';

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Only what's needed to rebuild the track. */
export function cleanDef(def) {
  if (!def) return def;
  if (def.kind === 'tiles') return { kind: 'tiles', width: def.width, cols: def.cols, rows: def.rows, tiles: def.tiles.map(t => { const o = { ...t }; delete o._painted; return o; }) };
  return { kind: 'spline', width: def.width, laps: def.laps, points: def.points.map(p => ({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 })) };
}

/** Plain code, available instantly (used by the developer menu as a fallback). */
export function encodeTrackSync(def) { return 'RAI0.' + toB64(new TextEncoder().encode(JSON.stringify(cleanDef(def)))); }

export async function encodeTrack(def) {
  const json = new TextEncoder().encode(JSON.stringify(cleanDef(def)));
  if (!canCompress) return 'RAI0.' + toB64(json);
  try { return 'RAI1.' + toB64(await pipe(json, new CompressionStream('deflate-raw'))); } catch { return 'RAI0.' + toB64(json); }
}

/** Returns the track definition, or throws an Error with a message for the player. */
export async function decodeTrack(code) {
  const c = String(code || '').trim().replace(/\s+/g, '');
  const m = /^RAI([01])\.([A-Za-z0-9_-]+)$/.exec(c);
  if (!m) throw new Error('That doesn’t look like a track code – it should start with RAI1. or RAI0.');
  let bytes;
  try { bytes = fromB64(m[2]); } catch { throw new Error('The track code is damaged – copy it again, all of it.'); }
  if (m[1] === '1') {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t open compressed track codes – try another browser.');
    try { bytes = await pipe(bytes, new DecompressionStream('deflate-raw')); } catch { throw new Error('The track code is damaged or cut off – copy it again, all of it.'); }
  }
  let def;
  try { def = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('The track code is damaged – copy it again, all of it.'); }
  if (!def || (def.kind === 'tiles' ? !Array.isArray(def.tiles) : !Array.isArray(def.points))) throw new Error('The track code doesn’t contain a track.');
  return def;
}
