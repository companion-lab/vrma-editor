// Parses a VRMA file (VRMC_vrm_animation glTF, GLB or JSON container)
// into the editor's canonical animation model.

export type Quat = [number, number, number, number]; // x y z w
export type Vec3 = [number, number, number];

// Velocity/transition curve from this key toward the NEXT key.
// 'linear' is the VRMA default; the others (incl. custom bezier curves) are
// baked to linear keys on export.
export type Ease = 'linear' | 'in' | 'out' | 'inout' | 'step' | 'custom';
export const EASES: Ease[] = ['linear', 'in', 'out', 'inout', 'step', 'custom'];

// Cubic-bezier handles [P1x, P1y, P2x, P2y] for the 'custom' ease — the same
// shape as CSS cubic-bezier(). X (time) is clamped to 0..1 when editing; Y may
// leave 0..1 for anticipation (<0) / follow-through (>1) like Blender handles.
export type Bez = [number, number, number, number];
export const DEFAULT_BEZ: Bez = [0.42, 0, 0.58, 1];
// Handles seeded when converting a preset into a custom curve.
export function seedBez(from: Ease | undefined): Bez {
  if (from === 'in') return [0.42, 0, 1, 1];
  if (from === 'out') return [0, 0, 0.58, 1];
  return DEFAULT_BEZ;
}

// Velocity/transition curves. `u` is the raw segment progress (0..1);
// the result is the eased progress used for interpolation. 'custom' is
// resolved through `bez` in easeAlpha, never through this table.
export const EASE_FUNCS: Record<Ease, (u: number) => number> = {
  linear: (u) => u,
  in: (u) => u * u, // quad-in
  out: (u) => 1 - (1 - u) * (1 - u), // quad-out
  inout: (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)), // quad-inout
  step: () => 0, // hold this key until the next one
  custom: (u) => u,
};

/** Evaluate the eased value at progress `x` (0..1) for a cubic bezier whose
 *  endpoints are (0,0)→(1,1) with handles at P1/P2. Solves X(u)=x for the
 *  curve parameter (Newton-Raphson, bisection fallback), then returns Y. */
export function evalCubicBezier(bez: Bez, x: number): number {
  const [x1, y1, x2, y2] = bez;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // power-basis coefficients: X(u) = ((ax·u + bx)·u + cx)·u
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sample = (a: number, b: number, c: number, u: number) => ((a * u + b) * u + c) * u;
  const sx = (u: number) => sample(ax, bx, cx, u);
  const sy = (v: number) => sample(ay, by, cy, v);
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  let u = x;
  for (let i = 0; i < 8; i++) {
    const err = sx(u) - x;
    if (Math.abs(err) < 1e-6) return sy(u);
    const d = dx(u);
    if (Math.abs(d) < 1e-6) break;
    u -= err / d;
  }
  let lo = 0;
  let hi = 1;
  u = x;
  for (let i = 0; i < 24; i++) {
    const err = sx(u) - x;
    if (Math.abs(err) < 1e-6) break;
    if (err < 0) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return sy(u);
}

export function easeAlpha(ease: Ease | undefined, u: number, bez?: Bez): number {
  if (ease === 'custom') return evalCubicBezier(bez ?? DEFAULT_BEZ, u);
  return (EASE_FUNCS[ease ?? 'linear'] ?? EASE_FUNCS.linear)(u);
}

export interface RotKey {
  id: number;
  t: number;
  q: Quat;
  ease?: Ease;
  /** Handles for the 'custom' ease. */
  bez?: Bez;
}
export interface PosKey {
  id: number;
  t: number;
  p: Vec3; // offset from T-pose rest position, meters
  ease?: Ease;
  bez?: Bez;
}
export interface ExprKey {
  id: number;
  t: number;
  w: number; // expression weight 0..1
  ease?: Ease;
  bez?: Bez;
}

export interface VrmaData {
  name: string;
  duration: number;
  rotTracks: Partial<Record<string, RotKey[]>>; // bone name -> sorted keys
  hipsTrack: PosKey[];
  /** Expression (blendshape) name (VRM 1.0 naming) -> sorted keys. */
  exprTracks: Record<string, ExprKey[]>;
  /** Rest hips height (Y) of the rig the animation was authored on.
   *  Read from the hips node's translation; used to rescale hips motion
   *  onto models of a different height (as the reference implementation does). */
  restHipsY: number;
}

let nextKeyId = 1;
export function allocKeyId(): number {
  return nextKeyId++;
}
export function peekKeyId(): number {
  return nextKeyId;
}
export function setKeyIdCursor(v: number) {
  nextKeyId = Math.max(nextKeyId, v);
}

export class VrmaParseError extends Error {}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface GltfJson {
  asset: { version: string; generator?: string };
  extensionsUsed?: string[];
  extensions?: { VRMC_vrm_animation?: any };
  nodes?: any[];
  animations?: any[];
  accessors?: any[];
  bufferViews?: any[];
  buffers?: any[];
}

function readGltf(buffer: ArrayBuffer): { json: GltfJson; bin: Uint8Array | null } {
  const dv = new DataView(buffer);
  if (buffer.byteLength >= 12 && dv.getUint32(0, true) === GLB_MAGIC) {
    const jsonLen = dv.getUint32(12, true);
    const jsonType = dv.getUint32(16, true);
    if (jsonType !== CHUNK_JSON) throw new VrmaParseError('Invalid GLB: first chunk is not JSON');
    const json: GltfJson = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)),
    );
    let bin: Uint8Array | null = null;
    let off = 20 + jsonLen;
    if (off + 8 <= buffer.byteLength && dv.getUint32(off + 4, true) === CHUNK_BIN) {
      const binLen = dv.getUint32(off, true);
      bin = new Uint8Array(buffer, off + 8, Math.min(binLen, buffer.byteLength - off - 8));
    }
    return { json, bin };
  }
  // Plain JSON (.gltf)
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  const json: GltfJson = JSON.parse(text);
  return { json, bin: null };
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  const meta = uri.slice(0, comma);
  const data = uri.slice(comma + 1);
  if (!meta.includes('base64')) {
    return new TextEncoder().encode(decodeURIComponent(data));
  }
  const raw = atob(data);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};
const TYPE_COUNT: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4,
};

// Decode one float accessor (VRMA accessors must be FLOAT).
function readFloatAccessor(json: GltfJson, bin: Uint8Array | null, index: number): Float32Array {
  const acc = json.accessors?.[index];
  if (!acc) throw new VrmaParseError(`Accessor ${index} not found`);
  if (acc.componentType !== 5126) {
    throw new VrmaParseError(
      `Accessor ${index}: only FLOAT (5126) is supported, got ${acc.componentType}`,
    );
  }
  if (acc.normalized) throw new VrmaParseError(`Accessor ${index}: normalized not supported`);
  const count: number = acc.count;
  const numComp: number = TYPE_COUNT[acc.type];
  if (numComp == null) throw new VrmaParseError(`Accessor ${index}: unsupported type ${acc.type}`);

  const bv = json.bufferViews?.[acc.bufferView];
  if (!bv) throw new VrmaParseError(`BufferView ${acc.bufferView} not found`);

  let bufData: Uint8Array;
  if (typeof bv.byteOffset === 'number' && bv.byteOffset === -1) {
    throw new VrmaParseError('Uninitialized bufferView not supported');
  }
  const buf = json.buffers?.[bv.buffer ?? 0];
  if (!buf) throw new VrmaParseError('Animation references a missing buffer');
  if (bin && (buf.uri == null || buf.uri === undefined)) {
    bufData = bin;
  } else if (buf.uri && buf.uri.startsWith('data:')) {
    bufData = decodeDataUri(buf.uri);
  } else if (bin) {
    bufData = bin;
  } else {
    throw new VrmaParseError('External buffer references are not supported');
  }

  const elemSize = numComp * 4;
  const stride: number = bv.byteStride || elemSize;
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Float32Array(count * numComp);

  if (stride === elemSize) {
    const view = new Float32Array(bufData.buffer, bufData.byteOffset + start, count * numComp);
    out.set(view);
  } else {
    const dv = new DataView(bufData.buffer, bufData.byteOffset + start);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < numComp; c++) {
        out[i * numComp + c] = dv.getFloat32(i * stride + c * 4, true);
      }
    }
  }
  return out;
}

interface RawTrack {
  times: Float32Array;
  values: Float32Array;
  numComp: number;
  interpolation: string;
}

function readTrack(json: GltfJson, bin: Uint8Array | null, sampler: any): RawTrack {
  const times = readFloatAccessor(json, bin, sampler.input);
  const numComp = TYPE_COUNT[json.accessors?.[sampler.output]?.type] ?? 3;
  const values = readFloatAccessor(json, bin, sampler.output);
  return { times, values, numComp, interpolation: sampler.interpolation || 'LINEAR' };
}

// Normalize STEP / CUBICSPLINE tracks down to LINEAR keyframes.
function toLinearKeys(track: RawTrack): { times: Float32Array; values: Float32Array } {
  const { times, values, numComp, interpolation } = track;
  if (interpolation === 'CUBICSPLINE') {
    // Values are stored [inTangent, value, outTangent] per key; keep the value.
    const n = times.length;
    const t = new Float32Array(n);
    const v = new Float32Array(n * numComp);
    for (let i = 0; i < n; i++) {
      t[i] = times[i];
      for (let c = 0; c < numComp; c++) {
        v[i * numComp + c] = values[i * 3 * numComp + numComp + c];
      }
    }
    return { times: t, values: v };
  }
  if (interpolation === 'STEP') {
    // Hold each value until the next key: duplicate key at t_{i+1} - eps.
    const n = times.length;
    const t: number[] = [];
    const v: number[] = [];
    for (let i = 0; i < n; i++) {
      t.push(times[i]);
      for (let c = 0; c < numComp; c++) v.push(values[i * numComp + c]);
      if (i + 1 < n && times[i + 1] > times[i]) {
        const eps = Math.min(1e-4, (times[i + 1] - times[i]) / 2);
        t.push(times[i + 1] - eps);
        for (let c = 0; c < numComp; c++) v.push(values[i * numComp + c]);
      }
    }
    return { times: new Float32Array(t), values: new Float32Array(v) };
  }
  return { times, values };
}

function parseQuaternionTrack(track: RawTrack, out: RotKey[]) {
  const { times, values } = toLinearKeys(track);
  out.length = 0;
  let lastT = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t <= lastT) continue; // drop duplicate/unordered times (keep first)
    const o = i * 4;
    const q: Quat = [values[o], values[o + 1], values[o + 2], values[o + 3]];
    const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    out.push({ id: allocKeyId(), t, q: [q[0] / len, q[1] / len, q[2] / len, q[3] / len] });
    lastT = t;
  }
}

function parseVec3Track(track: RawTrack, out: PosKey[]) {
  const { times, values } = toLinearKeys(track);
  out.length = 0;
  let lastT = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t <= lastT) continue;
    const o = i * 3;
    out.push({ id: allocKeyId(), t, p: [values[o], values[o + 1], values[o + 2]] });
    lastT = t;
  }
}

// Expression channels target a proxy node with a VEC3 translation whose X is
// the weight; be tolerant of other vector widths by taking component 0.
function parseWeightTrack(track: RawTrack, out: ExprKey[]) {
  const numComp = track.numComp;
  const { times, values } = toLinearKeys(track);
  out.length = 0;
  let lastT = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t <= lastT) continue;
    const w = Math.min(1, Math.max(0, values[i * numComp]));
    out.push({ id: allocKeyId(), t, w });
    lastT = t;
  }
}

export function parseVRMA(buffer: ArrayBuffer): VrmaData {
  const { json, bin } = readGltf(buffer);
  const ext = json.extensions?.VRMC_vrm_animation;
  if (!ext) {
    throw new VrmaParseError(
      'Not a VRMA file: missing VRMC_vrm_animation extension. (Did you mean to load this as a model?)',
    );
  }
  if (json.extensionsUsed && !json.extensionsUsed.includes('VRMC_vrm_animation')) {
    throw new VrmaParseError('Not a VRMA file: VRMC_vrm_animation not in extensionsUsed');
  }

  // Humanoid mapping: bone name -> node index.
  const boneByNode = new Map<number, string>();
  const humanBones = ext.humanoid?.humanBones ?? {};
  for (const [bone, entry] of Object.entries(humanBones as Record<string, any>)) {
    if (entry && typeof entry.node === 'number') boneByNode.set(entry.node, bone);
  }
  if (boneByNode.size === 0) {
    throw new VrmaParseError('VRMA has no humanoid bone mapping');
  }

  // Expression mapping: expression name -> proxy node index. Preset names are
  // the VRM 1.0 names three-vrm exposes at runtime, custom names map by name.
  const exprByNode = new Map<number, string>();
  const exprDecls = { ...ext.expressions?.preset, ...ext.expressions?.custom };
  for (const [name, entry] of Object.entries(exprDecls as Record<string, any>)) {
    if (entry && typeof entry.node === 'number' && !exprByNode.has(entry.node)) {
      exprByNode.set(entry.node, name);
    }
  }

  const anim = json.animations?.[0];
  if (!anim) throw new VrmaParseError('VRMA has no animation');

  const data: VrmaData = {
    name: anim.name || 'Imported animation',
    duration: 0,
    rotTracks: {},
    hipsTrack: [],
    exprTracks: {},
    restHipsY: 0,
  };

  let ignoredChannels = 0;
  for (const channel of anim.channels ?? []) {
    const node = channel.target?.node;
    const path = channel.target?.path;
    const bone = boneByNode.get(node);
    const exprName = bone == null && node != null ? exprByNode.get(node) : undefined;
    const sampler = anim.samplers?.[channel.sampler];
    if (!sampler || (bone == null && exprName == null)) {
      ignoredChannels++;
      continue;
    }
    if (path === 'rotation' && bone != null) {
      const keys = (data.rotTracks[bone] ??= []);
      parseQuaternionTrack(readTrack(json, bin, sampler), keys);
    } else if (path === 'translation' && bone === 'hips') {
      parseVec3Track(readTrack(json, bin, sampler), data.hipsTrack);
    } else if (path === 'translation' && exprName != null) {
      const keys = (data.exprTracks[exprName] ??= []);
      parseWeightTrack(readTrack(json, bin, sampler), keys);
    } else {
      ignoredChannels++;
    }
  }
  if (ignoredChannels > 0) {
    console.warn(`VRMA import: ignored ${ignoredChannels} unsupported channels (e.g. props)`);
  }

  let duration = 0;
  for (const keys of Object.values(data.rotTracks)) {
    for (const k of keys!) duration = Math.max(duration, k.t);
  }
  for (const k of data.hipsTrack) duration = Math.max(duration, k.t);
  for (const keys of Object.values(data.exprTracks)) {
    for (const k of keys) duration = Math.max(duration, k.t);
  }
  data.duration = duration > 0 ? duration : 0.001;

  // Rest hips height of the authoring rig: prefer the hips node's stored
  // translation (what THREE.GLTFExporter writes), fall back to the first
  // hips key, then 1m.
  const hipsNodeIndex = humanBones['hips']?.node;
  const hipsNode = hipsNodeIndex != null ? json.nodes?.[hipsNodeIndex] : undefined;
  const nodeTrans = hipsNode?.translation;
  if (nodeTrans && nodeTrans.length === 3 && Math.abs(nodeTrans[1]) > 1e-3) {
    data.restHipsY = nodeTrans[1];
  } else if (data.hipsTrack.length > 0) {
    data.restHipsY = data.hipsTrack[0].p[1];
  } else {
    data.restHipsY = 1;
  }

  const hasAny =
    Object.keys(data.rotTracks).length > 0 || data.hipsTrack.length > 0 || Object.keys(data.exprTracks).length > 0;
  if (!hasAny) throw new VrmaParseError('VRMA contains no humanoid animation tracks');

  return data;
}
