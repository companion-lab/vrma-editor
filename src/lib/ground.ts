// Foot-ground contact baking. Hand-authored (AI or mocap) animations pick
// hips heights by guesswork, but the height that keeps a foot planted depends
// on the leg poses of every frame — a static recipe cannot get it right, so
// the character ends up "flying" with feet above the floor. This pass samples
// the animation through the same FK the playback uses, measures the lowest
// foot/toe joint and rewrites the hips Y track so that joint rests exactly on
// its rest-pose ground height at every sample. Horizontal hips motion and the
// authored vertical bob (relative to the contact solve) are preserved.

import type { VRM } from '@pixiv/three-vrm';
import { Vector3 } from 'three';
import { applyPose, sampleVec3 } from './animation';
import { applyHipsLift, hipsLiftOffset } from './vrmedit/live';
import { allocKeyId, type PosKey, type VrmaData } from './vrma/parse';

const TMP_V = new Vector3();

/** Joints whose world height defines ground contact (the lowest one wins:
 *  the planted foot while walking, the toe pivot while the heel lifts). */
const CONTACT_BONES = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'] as const;

export interface GroundBakeResult {
  /** Rewritten hips track (dense linear keys). Empty when not applicable. */
  hipsTrack: PosKey[];
  /** Samples evaluated (0 = the rig has no foot/toe bones). */
  sampled: number;
  /** Largest downward body shift applied, metres (feet were floating). */
  maxDrop: number;
  /** Largest upward shift, metres (feet were penetrating the floor). */
  maxLift: number;
}

/**
 * Resample `data` and rebuild its hips track so the lowest foot/toe joint
 * stays at its rest-pose height — the ground — for the whole loop.
 *
 * Measurement mirrors the playback loop exactly: applyPose for the normalized
 * rig, then the whole-body hips lift from bone proportions (which the render
 * loop applies after the humanoid sync and which moves the rendered feet).
 * The resulting world-space correction is converted back into animation-space
 * hips Y with the same rest-height ratio applyPose uses.
 *
 * This pins the LOWEST foot down at every sample — right for walking in
 * place, wrong when the character should leave the ground (jumps, sitting):
 * callers opt out for those.
 */
export function bakeGroundFeet(
  vrm: VRM,
  data: VrmaData,
  restHips: Vector3,
  restFeetY: number,
  boneScale: Record<string, number> = {},
  bodyShape: Record<string, number> = {},
): GroundBakeResult {
  const empty: GroundBakeResult = { hipsTrack: [], sampled: 0, maxDrop: 0, maxLift: 0 };
  const humanoid = vrm.humanoid;
  if (!humanoid) return empty;
  const contactNodes = CONTACT_BONES.map((b) => humanoid.getRawBoneNode(b as never)).filter(
    (n): n is NonNullable<typeof n> => n != null,
  );
  if (contactNodes.length === 0) return empty;

  const duration = Math.max(0.1, data.duration);
  const animRestY = data.restHipsY;
  // Animation-space -> model-space hips scale (same ratio applyPose applies).
  const s = animRestY > 1e-3 ? restHips.y / animRestY : 1;
  // Whole-body hips lift from bone proportions — part of what playback renders.
  const lift = hipsLiftOffset(boneScale, bodyShape, restHips.y, restFeetY);
  // Rest hips height above the ground; bounds the correction for degenerate poses.
  const H = Math.max(0.1, restHips.y - restFeetY);

  // ~30 Hz, bounded: dense enough to keep the contact curve (kinks happen when
  // the lowest foot switches), sparse enough to stay editable on the timeline.
  const N = Math.min(96, Math.max(24, Math.round(duration * 30)));
  const authored: [number, number, number][] = [];
  const corr: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * duration;
    applyPose(vrm, data, t, restHips, animRestY);
    applyHipsLift(vrm, lift);
    let minY = Infinity;
    for (const n of contactNodes) {
      const y = n.getWorldPosition(TMP_V).y;
      if (y < minY) minY = y;
    }
    const p = data.hipsTrack.length > 0 ? sampleVec3(data.hipsTrack, t, TMP_V) : TMP_V.set(0, animRestY, 0);
    authored.push([p.x, p.y, p.z]);
    // Negative = body must move down (feet float), positive = up (penetrating).
    corr.push(Math.max(-H, Math.min(0.5 * H, restFeetY - minY)));
  }

  // Circular 3-tap smoothing over the loop: kills the small kink where the
  // lowest contact switches between feet without touching the overall shape.
  const smooth = corr.map((c, i) => {
    const a = corr[(i - 1 + N) % N];
    const b = corr[(i + 1) % N];
    return 0.25 * a + 0.5 * c + 0.25 * b;
  });

  const hipsTrack: PosKey[] = [];
  for (let i = 0; i < N; i++) {
    hipsTrack.push({
      id: allocKeyId(),
      t: (i / N) * duration,
      p: [authored[i][0], authored[i][1] + smooth[i] / s, authored[i][2]],
      ease: 'linear',
    });
  }
  // Close the loop: the wrap key mirrors t=0 when the authored track is
  // loop-seamless, otherwise keeps its own end value.
  const endP =
    data.hipsTrack.length > 0 ? sampleVec3(data.hipsTrack, duration, TMP_V) : TMP_V.set(0, animRestY, 0);
  const seamless = Math.abs(endP.y - authored[0][1]) < 0.002 && Math.abs(endP.x - authored[0][0]) < 0.002;
  hipsTrack.push({
    id: allocKeyId(),
    t: duration,
    p: seamless
      ? [hipsTrack[0].p[0], hipsTrack[0].p[1], hipsTrack[0].p[2]]
      : [endP.x, endP.y + smooth[N - 1] / s, endP.z],
    ease: 'linear',
  });

  return {
    hipsTrack,
    sampled: N,
    maxDrop: Math.max(0, -Math.min(...smooth)),
    maxLift: Math.max(0, Math.max(...smooth)),
  };
}
