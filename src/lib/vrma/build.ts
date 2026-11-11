// Builds a VRMA file (VRMC_vrm_animation as binary glTF / GLB) from the
// editor's animation model. Follows the VRM 1.0 animation spec:
//  - humanoid bone rotations as quaternion channels (T-pose relative)
//  - hips translation (optional, offset from rest position, meters)
//  - LINEAR interpolation, FLOAT accessors

import type { Ease, PosKey, Quat, RotKey, Vec3, VrmaData } from './parse';
import { EASE_FUNCS } from './parse';
import { BONE_ORDER_INDEX } from '../humanoid';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

// The VRMA spec requires LINEAR interpolation, so eased segments are baked
// into linear samples at this rate on export.
const BAKE_FPS = 30;

function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let b2 = b;
  if (dot < 0) {
    b2 = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  let k0: number;
  let k1: number;
  if (dot > 0.9995) {
    k0 = 1 - t;
    k1 = t;
  } else {
    const theta = Math.acos(Math.min(1, dot));
    const s = Math.sin(theta);
    k0 = Math.sin((1 - t) * theta) / s;
    k1 = Math.sin(t * theta) / s;
  }
  const out = [
    a[0] * k0 + b2[0] * k1,
    a[1] * k0 + b2[1] * k1,
    a[2] * k0 + b2[2] * k1,
    a[3] * k0 + b2[3] * k1,
  ];
  const len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  return [out[0] / len, out[1] / len, out[2] / len, out[3] / len];
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// Expand a key list into plain linear keys, resampling non-linear segments
// (ease-in / ease-out / in-out / step) at BAKE_FPS. A 'step' segment's
// intermediates all sit at the left key's value, producing a sharp jump.
function bakeTrack<T>(keys: { t: number; ease?: Ease }[], valueOf: (k: T) => any, lerp: (a: any, b: any, u: number) => any): { t: number; v: any }[] {
  const out: { t: number; v: any }[] = [];
  const ks = keys as (T & { t: number; ease?: Ease })[];
  for (let i = 0; i < ks.length; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    out.push({ t: a.t, v: valueOf(a) });
    if (!b || !a.ease || a.ease === 'linear') continue;
    const span = b.t - a.t;
    if (span <= 1e-9) continue;
    const n = Math.max(2, Math.ceil(span * BAKE_FPS));
    const fn = EASE_FUNCS[a.ease];
    for (let k = 1; k < n; k++) {
      const u = k / n;
      out.push({ t: a.t + span * u, v: lerp(valueOf(a), valueOf(b), fn(u)) });
    }
  }
  return out;
}

interface PendingAccessor {
  byteOffset: number;
  count: number;
  numComp: number;
  min: number[];
  max: number[];
}

class BinaryBuilder {
  chunks: Uint8Array[] = [];
  length = 0;

  addF32(values: Float32Array): number {
    // 4-byte alignment
    const pad = (4 - (this.length % 4)) % 4;
    if (pad > 0) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const offset = this.length;
    this.chunks.push(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    this.length += values.byteLength;
    return offset;
  }

  build(): Uint8Array {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }
}

function minMax(values: Float32Array, numComp: number): { min: number[]; max: number[] } {
  const min = new Array(numComp).fill(Infinity);
  const max = new Array(numComp).fill(-Infinity);
  for (let i = 0; i < values.length; i += numComp) {
    for (let c = 0; c < numComp; c++) {
      min[c] = Math.min(min[c], values[i + c]);
      max[c] = Math.max(max[c], values[i + c]);
    }
  }
  return { min, max };
}

export function buildVRMA(data: VrmaData): ArrayBuffer {
  // Bones to export: any bone with rotation keys, plus hips (for translation).
  const bones = new Set<string>(Object.keys(data.rotTracks).filter((b) => (data.rotTracks[b]?.length ?? 0) > 0));
  if (data.hipsTrack.length > 0) bones.add('hips');
  bones.add('hips'); // humanoid mapping always includes hips
  const boneList = [...bones].sort(
    (a, b) => (BONE_ORDER_INDEX[a] ?? 999) - (BONE_ORDER_INDEX[b] ?? 999),
  );
  if (boneList.length === 0) throw new Error('Nothing to export: animation has no keyframes');

  // --- nodes + humanoid mapping ---
  // The hips node carries its rest translation so consumers can rescale the
  // hips motion onto models of a different height (like the reference loader).
  const nodes = boneList.map((bone) =>
    bone === 'hips'
      ? { name: bone, translation: [0, data.restHipsY || 1, 0] }
      : { name: bone },
  );
  const humanBones: Record<string, { node: number }> = {};
  boneList.forEach((bone, i) => {
    humanBones[bone] = { node: i };
  });

  // --- samplers / channels / binary ---
  const bin = new BinaryBuilder();
  const bufferViews: any[] = [];
  const accessors: any[] = [];

  const addAccessor = (values: Float32Array, numComp: number, type: string) => {
    const byteOffset = bin.addF32(values);
    const { min, max } = minMax(values, numComp);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: values.byteLength });
    const index = accessors.length;
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: values.length / numComp,
      type,
      min,
      max,
    });
    return index;
  };

  const samplers: any[] = [];
  const channels: any[] = [];

  for (let i = 0; i < boneList.length; i++) {
    const bone = boneList[i];
    const rot = data.rotTracks[bone];
    if (rot && rot.length > 0) {
      const baked = bakeTrack<RotKey>(rot, (k) => k.q, slerpQuat);
      const times = new Float32Array(baked.length);
      const values = new Float32Array(baked.length * 4);
      baked.forEach((k, j) => {
        times[j] = k.t;
        values[j * 4] = k.v[0];
        values[j * 4 + 1] = k.v[1];
        values[j * 4 + 2] = k.v[2];
        values[j * 4 + 3] = k.v[3];
      });
      const timeAcc = addAccessor(times, 1, 'SCALAR');
      const valueAcc = addAccessor(values, 4, 'VEC4');
      const samplerIndex = samplers.length;
      samplers.push({ input: timeAcc, output: valueAcc, interpolation: 'LINEAR' });
      channels.push({ sampler: samplerIndex, target: { node: i, path: 'rotation' } });
    }
    if (bone === 'hips' && data.hipsTrack.length > 0) {
      const baked = bakeTrack<PosKey>(data.hipsTrack, (k) => k.p, lerpVec3);
      const times = new Float32Array(baked.length);
      const values = new Float32Array(baked.length * 3);
      baked.forEach((k, j) => {
        times[j] = k.t;
        values[j * 3] = k.v[0];
        values[j * 3 + 1] = k.v[1];
        values[j * 3 + 2] = k.v[2];
      });
      const timeAcc = addAccessor(times, 1, 'SCALAR');
      const valueAcc = addAccessor(values, 3, 'VEC3');
      const samplerIndex = samplers.length;
      samplers.push({ input: timeAcc, output: valueAcc, interpolation: 'LINEAR' });
      channels.push({ sampler: samplerIndex, target: { node: i, path: 'translation' } });
    }
  }

  if (channels.length === 0) throw new Error('Nothing to export: animation has no keyframes');

  const binData = bin.build();

  const json = {
    asset: {
      version: '2.0',
      generator: 'vrma-editor',
    },
    scene: 0,
    scenes: [{ name: 'VRMAnimation', nodes: boneList.map((_, i) => i) }],
    nodes,
    animations: [
      {
        name: data.name || 'animation',
        samplers,
        channels,
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binData.byteLength }],
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones },
      },
    },
  };

  // --- pack GLB ---
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  if (jsonPad > 0) {
    const padded = new Uint8Array(jsonBytes.byteLength + jsonPad);
    padded.set(jsonBytes);
    padded.fill(0x20, jsonBytes.byteLength); // pad with spaces
    jsonBytes = padded;
  }
  const binPad = (4 - (binData.byteLength % 4)) % 4;
  const total =
    12 + 8 + jsonBytes.byteLength + (binData.byteLength > 0 ? 8 + binData.byteLength + binPad : 0);

  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, GLB_VERSION, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, CHUNK_JSON, true);
  u8.set(jsonBytes, 20);
  let off = 20 + jsonBytes.byteLength;
  if (binData.byteLength > 0) {
    dv.setUint32(off, binData.byteLength + binPad, true);
    dv.setUint32(off + 4, CHUNK_BIN, true);
    u8.set(binData, off + 8);
    if (binPad > 0) u8.fill(0, off + 8 + binData.byteLength, off + 8 + binData.byteLength + binPad);
  }
  return out;
}
