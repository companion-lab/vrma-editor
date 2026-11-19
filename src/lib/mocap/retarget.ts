// Landmark frames (MediaPipe BlazePose) → VrmaData on the canonical humanoid
// rig. Bones are resolved top-down (FK): each bone's measured world-space
// direction is expressed in its parent's ACCUMULATED frame before becoming a
// local rotation, so limbs stay attached when the torso twists.
//
// Coordinate mapping MediaPipe world → canonical VRM space:
//   MP world: x right (as seen by the camera), y down, z smaller = closer.
//   Canonical: +X = the model's left (screen right), +Y up, +Z toward the
//   camera, identity = T-pose → (x, -y, -z). When the subject faces AWAY from
//   the camera the anatomical left/right assignment flips, so x is mirrored
//   to keep "subject's left" → "model's left".
//
// Monocular limitation: the world landmarks are hip-centered and the image
// depth is relative, so hips translation is recovered from image landmarks in
// the screen plane only (vertical bob + lateral sway); forward/backward hip
// travel is not recoverable and stays at 0.
//
// Fingers: MediaPipe's hand landmarker (21 landmarks per hand, up to two
// hands) runs alongside the pose landmarker. Each detected hand is matched to
// a body wrist by image-space proximity — the hand model's own handedness
// label assumes a mirrored input, which raw webcam frames are not. Finger
// segments swing from their canonical rest direction (along the arm; thumb
// forward in the palm-down T-pose) expressed in the owning bone's accumulated
// frame, like every other bone.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { allocKeyId, type PosKey, type RotKey, type VrmaData } from '../vrma/parse';
import type { HandFrame, MocapLandmark, PoseFrame } from './pose';

// BlazePose landmark indices.
const NOSE = 0;
const LEFT_EAR = 7;
const RIGHT_EAR = 8;
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_ELBOW = 13;
const RIGHT_ELBOW = 14;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
const LEFT_HIP = 23;
const RIGHT_HIP = 24;
const LEFT_KNEE = 25;
const RIGHT_KNEE = 26;
const LEFT_ANKLE = 27;
const RIGHT_ANKLE = 28;
const LEFT_TOE = 31;
const RIGHT_TOE = 32;

// HandLandmarker landmark indices (21 points per hand).
const HAND_WRIST = 0;
/** Per finger: the four joints root→tip. The thumb starts at the CMC joint,
 *  the other fingers at the MCP knuckle. */
const FINGER_CHAINS = [
  ['Thumb', 1, 2, 3, 4],
  ['Index', 5, 6, 7, 8],
  ['Middle', 9, 10, 11, 12],
  ['Ring', 13, 14, 15, 16],
  ['Little', 17, 18, 19, 20],
] as const;
const FINGER_PARTS = ['Proximal', 'Intermediate', 'Distal'] as const;

/** A bone segment is keyed only when both landmarks are this visible. */
const VIS_MIN = 0.5;

// Rest directions in canonical T-pose.
const REST_LEFT = new Vector3(1, 0, 0); // +X = model's left
const REST_RIGHT = new Vector3(-1, 0, 0);
const REST_UP = new Vector3(0, 1, 0);
const REST_DOWN = new Vector3(0, -1, 0);
const REST_FWD = new Vector3(0, 0, 1); // toes AND thumbs (palm-down T-pose) point forward

export interface RetargetInfo {
  /** Clip name (usually the video file name). */
  name: string;
  /** Segment start in the video — key times are rebased to 0. */
  start: number;
  /** Segment duration (becomes the clip duration). */
  duration: number;
  width: number;
  height: number;
}

export interface RetargetOptions {
  /** Smoothing window in frames per side, 0..10 (default 2). */
  smooth?: number;
  /** Drop keys reproducible by interpolation within this angle (degrees). */
  reductionDeg?: number;
}

export interface RetargetResult {
  data: VrmaData;
  /** Rotation track name → key count (excludes hips translation). */
  tracks: Record<string, number>;
  hipsKeys: number;
  /** Bones measured in < 40% of frames (usually occluded body parts). */
  sparseTracks: string[];
}

export function retargetPoses(frames: PoseFrame[], info: RetargetInfo, opts: RetargetOptions = {}): RetargetResult {
  if (frames.length < 2) {
    throw new Error('Not enough detected frames to build a motion clip.');
  }
  const smooth = Math.min(10, Math.max(0, Math.round(opts.smooth ?? 2)));
  const reductionDeg = Math.min(30, Math.max(0, opts.reductionDeg ?? 2));

  // Mirror state with hysteresis: the subject facing the camera puts the nose
  // closer than the shoulder line (smaller z); facing away flips left/right.
  let mirror = false;

  const rotAcc = new Map<string, RotKey[]>();
  /** Frames where each bone was actually measured (both landmarks visible) —
   *  the occlusion signal behind the sparseTracks warning. Counted before key
   *  reduction so a well-tracked but barely-moving bone (few keys after
   *  reduction) is not misreported as sparse. */
  const measuredFrames = new Map<string, number>();
  const hipsAcc: PosKey[] = [];
  let hipsRest: Vector3 | null = null;

  for (const frame of frames) {
    const r = retargetFrame(frame, info, mirror);
    mirror = r.mirror;
    for (const [bone, q] of r.rot) {
      measuredFrames.set(bone, (measuredFrames.get(bone) ?? 0) + 1);
      let keys = rotAcc.get(bone);
      if (!keys) rotAcc.set(bone, (keys = []));
      keys.push({ id: allocKeyId(), t: frame.t - info.start, q: [q.x, q.y, q.z, q.w] });
    }
    if (r.hips) {
      if (!hipsRest) hipsRest = r.hips.clone();
      const p = r.hips.clone().sub(hipsRest);
      // Clamp so a few bad frames can't throw the clip into orbit.
      p.clampScalar(-2, 2);
      hipsAcc.push({ id: allocKeyId(), t: frame.t - info.start, p: [p.x, p.y, p.z] });
    }
  }

  // Post-process: smoothing then reduction, per track.
  const rotTracks: Partial<Record<string, RotKey[]>> = {};
  for (const [bone, keys] of rotAcc) {
    let out = smooth ? smoothQuatKeys(keys, smooth) : keys;
    if (reductionDeg > 0) out = reduceQuatKeys(out, reductionDeg);
    rotTracks[bone] = out;
  }
  let hipsTrack = hipsAcc;
  if (smooth) hipsTrack = smoothPosKeys(hipsTrack, smooth);
  if (reductionDeg > 0) hipsTrack = reducePosKeys(hipsTrack, 0.004);

  const tracks: Record<string, number> = {};
  const sparseTracks: string[] = [];
  for (const [bone, keys] of Object.entries(rotTracks)) {
    tracks[bone] = keys!.length;
    const measured = measuredFrames.get(bone) ?? 0;
    if (measured < frames.length * 0.4) sparseTracks.push(bone);
  }

  return {
    data: {
      name: info.name,
      duration: Math.max(info.duration, 0.1),
      rotTracks,
      hipsTrack,
      exprTracks: {},
      restHipsY: 1, // authoring rig ≈ real-human meter space
    },
    tracks,
    hipsKeys: hipsTrack.length,
    sparseTracks,
  };
}

// --- Per-frame FK ---

/** One frame's retargeted pose, CANONICAL animation space (identity =
 *  T-pose). Live tracking applies these directly (with the VRM 0.x live-space
 *  flip); clip building packs them into RotKey/PosKey arrays. */
export interface FrameResult {
  rot: Map<string, Quaternion>;
  /** Hips position in canonical meters above screen-bottom / from screen-center (null = torso not visible). */
  hips: Vector3 | null;
  mirror: boolean;
}

export function retargetFrame(frame: PoseFrame, info: RetargetInfo, prevMirror: boolean): FrameResult {
  const { world, image } = frame;
  const v = (i: number) => toCanonical(world[i], prevMirror);
  const vis = (i: number) => image[i]?.visibility ?? world[i].visibility;
  const pairOk = (...idx: number[]) => idx.every((i) => vis(i) >= VIS_MIN);
  const swing = (rest: Vector3, dir: Vector3) => new Quaternion().setFromUnitVectors(rest, dir.normalize());
  const rot = new Map<string, Quaternion>();

  // Facing: nose closer to the camera than the shoulder line → facing camera
  // (no mirror); clearly farther → facing away (mirror); ambiguous → keep the
  // previous state so a noisy frame can't flicker left/right.
  const dz = world[NOSE].z - (world[LEFT_SHOULDER].z + world[RIGHT_SHOULDER].z) / 2;
  const mirror = dz > 0.05 ? true : dz < -0.05 ? false : prevMirror;

  // Accumulated world rotations (parent * child composition).
  const W = new Map<string, Quaternion>();
  const inv = (bone: string) => (W.get(bone) ?? new Quaternion()).clone().invert();

  // hips: pelvis twist/roll from the hip line (rest +X = model's left).
  const hipsVisible = pairOk(LEFT_HIP, RIGHT_HIP);
  if (hipsVisible) {
    const hipLine = v(LEFT_HIP).sub(v(RIGHT_HIP));
    if (hipLine.lengthSq() > 1e-8) {
      const qHips = swing(REST_LEFT, hipLine);
      rot.set('hips', qHips);
      W.set('hips', qHips);
    }
  }

  // spine + chest: torso lean (hipMid → shoulderMid), split half/half so the
  // chain composes to the measured direction exactly.
  const torsoVisible = hipsVisible && pairOk(LEFT_SHOULDER, RIGHT_SHOULDER);
  const hipMidW = mid(v(LEFT_HIP), v(RIGHT_HIP));
  const shoulderMidW = mid(v(LEFT_SHOULDER), v(RIGHT_SHOULDER));
  if (torsoVisible) {
    const torsoUp = shoulderMidW.clone().sub(hipMidW);
    if (torsoUp.lengthSq() > 1e-8) {
      const upInHips = torsoUp.normalize().applyQuaternion(inv('hips'));
      const qTorso = swing(REST_UP, upInHips);
      const half = new Quaternion().slerp(qTorso, 0.5);
      rot.set('spine', half.clone());
      rot.set('chest', half.clone());
      W.set('spine', (W.get('hips') ?? new Quaternion()).clone().multiply(half));
      W.set('chest', W.get('spine')!.clone().multiply(half));
    }
  }
  W.set('neck', W.get('chest') ?? new Quaternion());

  // head: full basis from the ear line (rest +X) and the nose direction
  // through the face (rest ≈ +Z) — captures yaw, pitch and roll.
  if (pairOk(LEFT_EAR, RIGHT_EAR, NOSE)) {
    const x = v(LEFT_EAR).sub(v(RIGHT_EAR)).normalize();
    const zRaw = v(NOSE).sub(mid(v(LEFT_EAR), v(RIGHT_EAR)));
    const z = zRaw.sub(x.clone().multiplyScalar(zRaw.dot(x))).normalize();
    const y = new Vector3().crossVectors(z, x); // rest: Z × X = Y
    const qHead = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
    rot.set('head', inv('neck').multiply(qHead));
    W.set('head', (W.get('neck') ?? new Quaternion()).clone().multiply(rot.get('head')!));
  }

  // Arms (parent frame = chest; shoulder bones stay identity).
  for (const [side, S, E, Wr] of [
    ['left', LEFT_SHOULDER, LEFT_ELBOW, LEFT_WRIST],
    ['right', RIGHT_SHOULDER, RIGHT_ELBOW, RIGHT_WRIST],
  ] as const) {
    const rest = side === 'left' ? REST_LEFT : REST_RIGHT;
    if (pairOk(S, E)) {
      const dir = v(E).sub(v(S)).normalize().applyQuaternion(inv('chest'));
      const q = swing(rest, dir);
      rot.set(`${side}UpperArm`, q);
      W.set(`${side}UpperArm`, (W.get('chest') ?? new Quaternion()).clone().multiply(q));
      if (pairOk(E, Wr)) {
        const dir2 = v(Wr).sub(v(E)).normalize().applyQuaternion(inv(`${side}UpperArm`));
        const q2 = swing(rest, dir2);
        rot.set(`${side}LowerArm`, q2);
        W.set(`${side}LowerArm`, W.get(`${side}UpperArm`)!.clone().multiply(q2));
      }
    }
  }

  // Legs (parent frame = hips).
  for (const [side, H, K, A, T] of [
    ['left', LEFT_HIP, LEFT_KNEE, LEFT_ANKLE, LEFT_TOE],
    ['right', RIGHT_HIP, RIGHT_KNEE, RIGHT_ANKLE, RIGHT_TOE],
  ] as const) {
    if (pairOk(H, K)) {
      const dir = v(K).sub(v(H)).normalize().applyQuaternion(inv('hips'));
      const q = swing(REST_DOWN, dir);
      rot.set(`${side}UpperLeg`, q);
      W.set(`${side}UpperLeg`, (W.get('hips') ?? new Quaternion()).clone().multiply(q));
      if (pairOk(K, A)) {
        const dir2 = v(A).sub(v(K)).normalize().applyQuaternion(inv(`${side}UpperLeg`));
        const q2 = swing(REST_DOWN, dir2);
        rot.set(`${side}LowerLeg`, q2);
        W.set(`${side}LowerLeg`, W.get(`${side}UpperLeg`)!.clone().multiply(q2));
        if (pairOk(A, T)) {
          const dir3 = v(T).sub(v(A)).normalize().applyQuaternion(inv(`${side}LowerLeg`));
          rot.set(`${side}Foot`, swing(REST_FWD, dir3));
        }
      }
    }
  }

  // Fingers: match each detected hand to a body wrist by image-space proximity
  // (the hand model's handedness label assumes mirrored input — see header),
  // then swing each finger segment from its canonical rest direction expressed
  // in the owning bone's accumulated frame: the proximal segment hangs off the
  // side's lowerArm, the rest chain down the finger. Uses prevMirror so finger
  // directions stay in the same frame as the arm bones they attach to.
  if (frame.hands?.length) {
    const handDist = (h: HandFrame, wIdx: number) => {
      const dx = (h.image[HAND_WRIST].x - image[wIdx].x) * info.width;
      const dy = (h.image[HAND_WRIST].y - image[wIdx].y) * info.height;
      return dx * dx + dy * dy;
    };
    const dL = frame.hands.map((h) => handDist(h, LEFT_WRIST));
    const dR = frame.hands.map((h) => handDist(h, RIGHT_WRIST));
    // Optimal wrist assignment for the ≤2 detected hands (one hand → nearest
    // wrist; two hands → the pairing with the lower total distance).
    const swap = frame.hands.length === 2 && dL[0] + dR[1] > dL[1] + dR[0];
    for (let hi = 0; hi < frame.hands.length; hi++) {
      const side =
        frame.hands.length === 1
          ? dL[0] <= dR[0]
            ? 'left'
            : 'right'
          : (hi === 0) !== swap
            ? 'left'
            : 'right';
      if (!W.has(`${side}LowerArm`)) continue; // arm unmeasured this frame — nothing to anchor to
      const hand = frame.hands[hi];
      const hw = (i: number) => toCanonical(hand.world[i], prevMirror);
      for (const [name, j0, j1, j2, j3] of FINGER_CHAINS) {
        const rest = name === 'Thumb' ? REST_FWD : side === 'left' ? REST_LEFT : REST_RIGHT;
        // Each finger chains down from the wrist (not from the previous finger).
        let parentW = W.get(`${side}LowerArm`)!.clone();
        const segs = [
          [j0, j1],
          [j1, j2],
          [j2, j3],
        ];
        for (let s = 0; s < segs.length; s++) {
          const dir = hw(segs[s][1]).sub(hw(segs[s][0]));
          if (dir.lengthSq() < 1e-10) continue; // coincident landmarks — hold this segment
          const q = swing(rest, dir.applyQuaternion(parentW.clone().invert()));
          rot.set(`${side}${name}${FINGER_PARTS[s]}`, q);
          parentW.multiply(q); // next segment hangs off this one
        }
      }
    }
  }

  // Hips translation: image-space hip midpoint scaled to meters via the torso
  // length (world landmarks are metric). Screen plane only — x/y, z stays 0.
  let hips: Vector3 | null = null;
  if (torsoVisible) {
    const hipMidImg = midImg(image[LEFT_HIP], image[RIGHT_HIP]);
    const shoMidImg = midImg(image[LEFT_SHOULDER], image[RIGHT_SHOULDER]);
    const torsoPx = Math.hypot(
      (shoMidImg.x - hipMidImg.x) * info.width,
      (shoMidImg.y - hipMidImg.y) * info.height,
    );
    const torsoM = shoulderMidW.clone().sub(hipMidW).length();
    if (torsoPx > 2 && torsoM > 0.05) {
      const mPerPx = torsoM / torsoPx;
      const x = (hipMidImg.x * info.width - info.width / 2) * mPerPx * (mirror ? -1 : 1);
      const y = (info.height - hipMidImg.y * info.height) * mPerPx;
      hips = new Vector3(x, y, 0);
    }
  }

  return { rot, hips, mirror };
}

function toCanonical(l: MocapLandmark, mirror: boolean): Vector3 {
  return new Vector3(mirror ? -l.x : l.x, -l.y, -l.z);
}

function mid(a: Vector3, b: Vector3): Vector3 {
  return new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

function midImg(a: MocapLandmark, b: MocapLandmark): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// --- Track post-processing ---

/** Windowed moving-average over quaternions via chained slerp. */
function smoothQuatKeys(keys: RotKey[], w: number): RotKey[] {
  const out: RotKey[] = keys.map((k) => ({ ...k, q: [...k.q] as [number, number, number, number] }));
  for (let i = 0; i < keys.length; i++) {
    const acc = new Quaternion(keys[i].q[0], keys[i].q[1], keys[i].q[2], keys[i].q[3]);
    let n = 1;
    for (let d = 1; d <= w; d++) {
      const a = keys[Math.max(0, i - d)];
      const b = keys[Math.min(keys.length - 1, i + d)];
      acc.slerp(new Quaternion(a.q[0], a.q[1], a.q[2], a.q[3]), 1 / (n + 1));
      n++;
      acc.slerp(new Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]), 1 / (n + 1));
      n++;
    }
    out[i].q = [acc.x, acc.y, acc.z, acc.w];
  }
  return out;
}

function smoothPosKeys(keys: PosKey[], w: number): PosKey[] {
  const out: PosKey[] = keys.map((k) => ({ ...k, p: [...k.p] as [number, number, number] }));
  for (let i = 0; i < keys.length; i++) {
    for (let axis = 0; axis < 3; axis++) {
      let sum = keys[i].p[axis];
      let n = 1;
      for (let d = 1; d <= w; d++) {
        sum += keys[Math.max(0, i - d)].p[axis] + keys[Math.min(keys.length - 1, i + d)].p[axis];
        n += 2;
      }
      out[i].p[axis] = sum / n;
    }
  }
  return out;
}

/** Drop keys whose pose is within `deg` of the straight interpolation of their
 *  neighbors (first/last always kept). */
function reduceQuatKeys(keys: RotKey[], deg: number): RotKey[] {
  if (keys.length < 3) return keys;
  const keep: RotKey[] = [];
  const rad = (deg * Math.PI) / 180;
  for (let i = 0; i < keys.length; i++) {
    if (i === 0 || i === keys.length - 1) {
      keep.push(keys[i]);
      continue;
    }
    const prev = keep[keep.length - 1];
    const next = keys[i + 1];
    const span = next.t - prev.t;
    const u = span > 1e-6 ? (keys[i].t - prev.t) / span : 0;
    const interp = new Quaternion(prev.q[0], prev.q[1], prev.q[2], prev.q[3]).slerp(
      new Quaternion(next.q[0], next.q[1], next.q[2], next.q[3]),
      u,
    );
    const cur = new Quaternion(keys[i].q[0], keys[i].q[1], keys[i].q[2], keys[i].q[3]);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(interp.dot(cur))));
    if (angle > rad) keep.push(keys[i]);
  }
  return keep;
}

function reducePosKeys(keys: PosKey[], meters: number): PosKey[] {
  if (keys.length < 3) return keys;
  const keep: PosKey[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (i === 0 || i === keys.length - 1) {
      keep.push(keys[i]);
      continue;
    }
    const prev = keep[keep.length - 1];
    const next = keys[i + 1];
    const span = next.t - prev.t;
    const u = span > 1e-6 ? (keys[i].t - prev.t) / span : 0;
    const d2 = Math.sqrt(
      (prev.p[0] + (next.p[0] - prev.p[0]) * u - keys[i].p[0]) ** 2 +
        (prev.p[1] + (next.p[1] - prev.p[1]) * u - keys[i].p[1]) ** 2 +
        (prev.p[2] + (next.p[2] - prev.p[2]) * u - keys[i].p[2]) ** 2,
    );
    if (d2 > meters) keep.push(keys[i]);
  }
  return keep;
}
