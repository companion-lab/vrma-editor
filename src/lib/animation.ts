// Pose sampling & application. VRMA rotations are authored in the
// normalized humanoid space where T-pose == identity, which is exactly what
// three-vrm's normalized rig provides (for both VRM 0.x and 1.0 models).

import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { Quaternion, Vector3 } from 'three';
import { easeAlpha, EASE_FUNCS } from './vrma/parse';
import type { Ease, PosKey, RotKey, VrmaData, Quat, Vec3 } from './vrma/parse';

const IDENTITY_Q = new Quaternion(0, 0, 0, 1);

// Velocity/transition curves live in vrma/parse.ts (pure, shared with the
// exporter); re-exported here for convenience.
export { easeAlpha, EASE_FUNCS };

/** Get a normalized humanoid bone node by plain string name. */
export function getNormNode(vrm: VRM, bone: string) {
  return vrm.humanoid?.getNormalizedBoneNode(bone as VRMHumanBoneName) ?? null;
}

// Bones manually manipulated since the last time change: the pose playback
// leaves these alone so live edits don't fight with the sampler.
export const manipulatedBones = new Set<string>();
export function clearManipulated() {
  manipulatedBones.clear();
}

function upperBound(keys: { t: number }[], t: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sampleQuaternion(keys: RotKey[], t: number, out: Quaternion): Quaternion {
  if (keys.length === 0) return out.copy(IDENTITY_Q);
  const i = upperBound(keys, t);
  if (i === 0) return setFromQuat(out, keys[0].q);
  if (i >= keys.length) return setFromQuat(out, keys[keys.length - 1].q);
  const a = keys[i - 1];
  const b = keys[i];
  const span = b.t - a.t;
  const alpha = span > 1e-9 ? easeAlpha(a.ease, (t - a.t) / span, a.bez) : 0;
  return setFromQuat(out, a.q).slerp(setFromQuat(TMP_Q, b.q), alpha);
}

const TMP_Q = new Quaternion();
function setFromQuat(out: Quaternion, q: Quat): Quaternion {
  return out.set(q[0], q[1], q[2], q[3]);
}

const TMP_V = new Vector3(); // scratch for applyPose's hips offset
const TMP_V2 = new Vector3(); // scratch inside sampleVec3 (must not alias `out`)

export function sampleVec3(keys: PosKey[], t: number, out: Vector3): Vector3 {
  if (keys.length === 0) return out.set(0, 0, 0);
  const i = upperBound(keys, t);
  if (i === 0) return out.set(keys[0].p[0], keys[0].p[1], keys[0].p[2]);
  if (i >= keys.length) {
    const k = keys[keys.length - 1];
    return out.set(k.p[0], k.p[1], k.p[2]);
  }
  const a = keys[i - 1];
  const b = keys[i];
  const span = b.t - a.t;
  const alpha = span > 1e-9 ? easeAlpha(a.ease, (t - a.t) / span, a.bez) : 0;
  out.set(a.p[0], a.p[1], a.p[2]);
  out.lerp(TMP_V2.set(b.p[0], b.p[1], b.p[2]), alpha);
  return out;
}

/**
 * Apply the animation pose at `time` to the VRM's normalized humanoid bones.
 * Bones without tracks get their rest (T-pose) transform.
 *
 * `data` holds canonical VRMA-space values (as authored in .vrma files).
 * three-vrm's normalized rig for VRM 0.x models faces the opposite way
 * relative to the canonical (+Z) animation space, so — matching the
 * reference @pixiv/three-vrm-animation implementation — quaternion x/z
 * components are conjugated and hips translation is mirrored + scaled by
 * modelRestY/animRestY when the target model is VRM 0.x.
 */
export function applyPose(
  vrm: VRM,
  data: VrmaData | null,
  time: number,
  restHips: Vector3,
  animRestY: number,
): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;
  const flip = vrm.meta?.metaVersion === '0';

  const hips = getNormNode(vrm, 'hips');
  if (hips) {
    if (data && data.hipsTrack.length > 0 && !manipulatedBones.has('hips')) {
      const p = sampleVec3(data.hipsTrack, time, TMP_V);
      const s = animRestY > 1e-3 ? restHips.y / animRestY : 1;
      hips.position.set(flip ? -p.x * s : p.x * s, p.y * s, flip ? -p.z * s : p.z * s);
    } else {
      hips.position.copy(restHips);
    }
  }
  for (const bone of Object.keys(humanoid.humanBones)) {
    const node = getNormNode(vrm, bone);
    if (!node) continue;
    if (manipulatedBones.has(bone)) continue;
    const keys = data?.rotTracks[bone];
    if (keys && keys.length > 0) {
      sampleQuaternion(keys, time, node.quaternion);
      if (flip) {
        node.quaternion.set(-node.quaternion.x, node.quaternion.y, -node.quaternion.z, node.quaternion.w);
      }
    } else {
      node.quaternion.copy(IDENTITY_Q);
    }
  }
  vrm.humanoid.update();
}

export function captureQuat(vrm: VRM, bone: string): Quat | null {
  const node = getNormNode(vrm, bone);
  if (!node) return null;
  node.quaternion.normalize();
  // live (normalized rig) space -> canonical VRMA space
  if (vrm.meta?.metaVersion === '0') {
    return [-node.quaternion.x, node.quaternion.y, -node.quaternion.z, node.quaternion.w];
  }
  return [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w];
}

/**
 * Capture the live hips position as canonical VRMA translation.
 * `animRestY` is the rest hips height of the animation being edited.
 */
export function captureHipsPosition(vrm: VRM, restHips: Vector3, animRestY: number): Vec3 | null {
  const node = getNormNode(vrm, 'hips');
  if (!node) return null;
  const s = animRestY > 1e-3 ? restHips.y / animRestY : 1;
  const flip = vrm.meta?.metaVersion === '0';
  return [
    flip ? -node.position.x / s : node.position.x / s,
    node.position.y / s,
    flip ? -node.position.z / s : node.position.z / s,
  ];
}

/** Reset all normalized bones to T-pose rest. */
export function resetToRestPose(vrm: VRM, restHips: Vector3): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;
  for (const bone of Object.keys(humanoid.humanBones)) {
    const node = getNormNode(vrm, bone);
    if (node) node.quaternion.identity();
  }
  const hips = getNormNode(vrm, 'hips');
  if (hips) hips.position.copy(restHips);
  humanoid.update();
  clearManipulated();
}
