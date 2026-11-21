// Wardrobe live wearing: declarative worn state ("donor X, part Y") reconciled
// onto the scene, plus the per-frame sync that makes worn donor meshes follow
// the current model's skeleton.
//
// The donor's own VRM scene is attached under a wardrobeRoot group next to the
// main model — no cloning, so donor VRM APIs (springbones) keep working. At
// wear time each worn donor SkinnedMesh gets its inverse bind matrices
// remapped onto the target skeleton (rebindWornMeshes below — the same result
// the export bake produces, so the preview always matches the saved file).
// Every frame each shared humanoid RAW bone's world position+rotation is
// copied from the target to the donor (skinned meshes bind to raw bones;
// world-space copying absorbs VRM 0.x root rotations and rest-pose
// differences). Donor sub-bones outside the humanoid map (VRoid "J_Sec_" hair
// chains) follow their parents rigidly, and the donor's springbone manager is
// stepped afterwards so hair keeps its sway.

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { BONE_ORDER } from '../humanoid';
import {
  applyAssetVisibilityAll,
  collectParts,
  collectWholeMeshes,
  partObject,
  type PartCategory,
  type PartId,
} from '../vrmedit/parts';
import { conventionRotation } from './bake';
import { AUTO_REPLACE_CATEGORIES, getDonor, type DonorSource } from './sources';

export interface WornRef {
  /** Donor model name (the wardrobe entry the part came from). */
  donor: string;
  /** AssetPart id — "mesh:primitive" or a whole-mesh name. */
  id: PartId;
  /** Category recorded at wear time so conflict-hiding works without the donor loaded. */
  category: PartCategory;
  /** Target parts this wear auto-hid (same-category originals) — unwearing
   *  removes exactly these from the hidden lists. Filled by the store. */
  replacedMeshes: string[];
  replacedParts: string[];
}

/** Whole-mesh part ids are plain three.js mesh names; primitive ids are "m:p". */
const isPrimitiveId = (id: PartId) => id.includes(':');

// --- target rest pose (captured at model load) ---

/** Humanoid bone name → FILE rest-pose world matrix, per target model. */
const TARGET_REST = new WeakMap<VRM, Map<string, THREE.Matrix4>>();

/**
 * Capture the loaded model's humanoid rest pose (before any posing). Call once
 * from the Viewport right after load; worn donors bind against these.
 */
export function captureTargetRestWorlds(vrm: VRM): void {
  if (TARGET_REST.has(vrm)) return;
  vrm.scene.updateMatrixWorld(true);
  // matrixWorld includes the runtime facing rotation; store the file-space rest.
  const cInv = conventionRotation((vrm.meta as { metaVersion?: string } | undefined)?.metaVersion).invert();
  const map = new Map<string, THREE.Matrix4>();
  for (const bone of BONE_ORDER) {
    const node = vrm.humanoid?.getRawBoneNode(bone as never);
    if (node) map.set(bone, new THREE.Matrix4().multiplyMatrices(cInv, node.matrixWorld));
  }
  TARGET_REST.set(vrm, map);
}

// --- worn mesh rebinding (inverse bind remap) ---

/**
 * Remap the inverse bind matrices of the donor's worn SkinnedMeshes onto the
 * target skeleton. The donor scene keeps its OWN skeleton (so sub-bone hair
 * chains + springbones keep working), but every humanoid RAW bone's world is
 * copied from the target each frame — the donor humanoid joints land exactly
 * on the target's bones. A donor vertex must therefore render as
 * `C_target · (its donor-file-space position re-fitted onto the target's
 * joints)`, where the re-fit maps each vertex's world offset from the donor's
 * joint onto the target's joint, rotated by the facing convention:
 *
 *   desired(v) = A_t_runtime_pos + R_rel · (v − A_d_file_pos)
 *
 * with A_d/A_t the donor/target humanoid joint of the same bone name and
 * R_rel the donor→runtime facing rotation (a VRM 0.x file faces the opposite
 * way of the runtime world, where every loaded model — VRM 0.x after
 * rotateVRM0, VRM 1.0 natively — faces +Z; hence R_rel is independent of the
 * target's file version). Per joint j (A = its nearest humanoid ancestor,
 * itself when humanoid):
 *
 *   - j humanoid (j == A):  IBM_new = A_t_runtime⁻¹ · M   (rideWorld below)
 *   - j sub-bone:           IBM_new = IBM_donor (unchanged — its joint rides
 *     the compensated local chain set up by rideSubBones, which folds the
 *     same ride into the chain root's local transform)
 *
 * For humanoid joints this matches the export bake (bake.ts remapSkin), so
 * the preview always matches the saved file.
 */
function rebindWornMeshes(donor: DonorSource, wornIds: Set<PartId>, target: VRM): void {
  const targetRest = TARGET_REST.get(target);
  if (!targetRest) return; // captureTargetRestWorlds not called yet — try next sync

  // Donor humanoid node → canonical bone name.
  const nodeToName = new Map<THREE.Object3D, string>();
  for (const bone of BONE_ORDER) {
    const node = donor.vrm.humanoid?.getRawBoneNode(bone as never);
    if (node) nodeToName.set(node, bone);
  }

  const cRotTarget = conventionRotation((target.meta as { metaVersion?: string } | undefined)?.metaVersion);
  const relR = conventionRotation((donor.vrm.meta as { metaVersion?: string } | undefined)?.metaVersion);

  for (const mesh of wornSkinnedMeshes(donor, wornIds)) {
    const skel = mesh.skeleton;
    if (!skel) continue;
    // Always remap from the pristine donor IBM (see PRISTINE_IBMS).
    const originals = pristineInverses(skel);
    skel.bones.forEach((b, i) => {
      const ibm = originals[i] ?? new THREE.Matrix4();
      const name = nodeToName.get(b);
      if (name) {
        // The joint IS a humanoid bone: at rest its runtime world is
        // cRot_target · targetRest, so binding through the ride map makes
        // the vertex render at M · v and follow the target's bone after.
        const aRest = targetRest.get(name);
        const aDonor = donor.restWorlds.get(name);
        if (!aRest || !aDonor) return;
        rideWorld(_ibmNew, cRotTarget, aRest, aDonor, relR); // _ibmNew = M
        _rideA.multiplyMatrices(cRotTarget, aRest);          // A_t_runtime
        _ibmNew.premultiply(_rideA.invert());                // IBM_new = A_t_runtime⁻¹ · M
      } else {
        // Sub-bone: its runtime world rides the compensated local chain
        // (rideSubBones) — the ride is folded into the chain root's local
        // transform, so the donor bind must stay untouched.
        _ibmNew.copy(ibm);
      }
      if (skel.boneInverses[i]) skel.boneInverses[i].copy(_ibmNew);
    });
  }
}

/**
 * The world-space ride `M` anchoring the donor humanoid joint `aDonorFile`
 * (FILE rest world) onto the target's joint `aRestFile` (FILE rest world —
 * the runtime world is `cRotTarget · aRestFile`) with the facing rotation
 * `R_rel` and an optional uniform `scale` in between:
 *
 *   M · x = A_t_runtime_pos + scale · R_rel · (x − A_d_file_pos)
 *
 * `scale` resizes the transferred subtree about the anchor joint — the head
 * size ratio for hair chains (target/donor head bone length) so hair from a
 * smaller-headed donor still covers a bigger head.
 */
function rideWorld(
  out: THREE.Matrix4,
  cRotTarget: THREE.Matrix4,
  aRestFile: THREE.Matrix4,
  aDonorFile: THREE.Matrix4,
  relR: THREE.Matrix4,
  scale = 1,
): void {
  const aRuntime = _rideA.multiplyMatrices(cRotTarget, aRestFile); // target joint's runtime rest world
  const aPos = _rideP.setFromMatrixColumn(aRuntime, 3);
  const aDonorPos = _rideP2.setFromMatrixColumn(aDonorFile, 3);
  out.makeTranslation(aPos.x, aPos.y, aPos.z);                     // T(A_t_pos)
  out.multiply(relR);                                              // · R_rel
  if (Math.abs(scale - 1) > 1e-4) out.multiply(_rideS.makeScale(scale, scale, scale)); // · S
  out.multiply(_rideRight.makeTranslation(-aDonorPos.x, -aDonorPos.y, -aDonorPos.z)); // · T(−A_d_pos)
}

interface AttachedDonor {
  donor: DonorSource;
  /** Bone pairs cached per target model (raw humanoid bones, world-synced). */
  target: VRM | null;
  pairs: [THREE.Object3D, THREE.Object3D][];
  /** Set when the donor's springbone verlet state is stale (attach or re-sync)
   *  — the next updateWornParts resets it onto the current configuration.
   *  Donor springbones are weak (VRM 0.x hair often has gravity ≈ 0.1 and no
   *  stiffness), so a chain teleported by the bone sync would otherwise stay
   *  stretched out forever instead of falling back into place. */
  needsSpringReset: boolean;
}

let wardrobeRoot: THREE.Group | null = null;
const attached = new Map<string, AttachedDonor>();

/** The group worn donor scenes live in. The Viewport adds it to the scene once. */
export function wardrobeGroup(): THREE.Group {
  if (!wardrobeRoot) wardrobeRoot = new THREE.Group();
  wardrobeRoot.name = 'wardrobeRoot';
  return wardrobeRoot;
}

/** Detach everything (model unloading). Donors stay in the registry. */
export function detachAllWorn(): void {
  if (!wardrobeRoot) return;
  for (const a of attached.values()) wardrobeRoot.remove(a.donor.vrm.scene);
  attached.clear();
}

/**
 * Reconcile the declarative worn list with the scene: attach donors that
 * gained worn parts, detach donors with none, show ONLY the worn parts on
 * each donor (everything else on the donor is hidden, including face/body
 * pieces), and rebind the worn meshes onto the target skeleton. Returns the
 * target parts the wear action must hide (same-category originals) plus
 * donors that are not loaded (their files are gone this session).
 */
export function syncWorn(
  vrm: VRM | null,
  worn: WornRef[],
): { replacedMeshes: string[]; replacedParts: string[]; missing: string[] } {
  const root = wardrobeGroup();

  const byDonor = new Map<string, Set<PartId>>();
  for (const w of worn) {
    let set = byDonor.get(w.donor);
    if (!set) byDonor.set(w.donor, (set = new Set()));
    set.add(w.id);
  }

  // Attach / update / detach
  for (const [name, ids] of byDonor) {
    const donor = getDonor(name);
    if (!donor) continue;
    let a = attached.get(name);
    if (!a) {
      root.add(donor.vrm.scene);
      a = { donor, target: null, pairs: [], needsSpringReset: true };
      attached.set(name, a);
    }
    a.needsSpringReset = true; // bones may have jumped (attach, undo/redo, re-wear)
    showOnlyWornParts(donor, ids);
    if (vrm) rebindWornMeshes(donor, ids, vrm);
  }
  for (const [name, a] of [...attached]) {
    if (!byDonor.has(name)) {
      root.remove(a.donor.vrm.scene);
      attached.delete(name);
    }
  }

  return { ...computeReplaced(vrm, worn), missing: [...byDonor.keys()].filter((n) => !getDonor(n)) };
}

/** Hide everything on the donor except the worn parts. */
function showOnlyWornParts(donor: DonorSource, wornIds: Set<PartId>): void {
  const hiddenMeshes: string[] = [];
  const hiddenParts: string[] = [];
  for (const p of donor.parts) {
    if (wornIds.has(p.id)) continue;
    (isPrimitiveId(p.id) ? hiddenParts : hiddenMeshes).push(p.id);
  }
  applyAssetVisibilityAll(donor.vrm, hiddenMeshes, hiddenParts);
  // Worn skinned meshes move via bones, which can take vertices far outside
  // the geometry's node-space bounds — never frustum-cull them.
  for (const id of wornIds) {
    const obj = isPrimitiveId(id) ? partObject(donor.vrm, id) : donor.vrm.scene.getObjectByName(id);
    if (obj) obj.traverse((o) => ((o as THREE.Mesh).frustumCulled = false));
  }
}

/** The SkinnedMesh objects behind worn part ids. */
function wornSkinnedMeshes(donor: DonorSource, wornIds: Set<PartId>): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  const seen = new Set<THREE.SkinnedMesh>();
  for (const id of wornIds) {
    const obj = isPrimitiveId(id) ? partObject(donor.vrm, id) : donor.vrm.scene.getObjectByName(id);
    if (!obj) continue;
    obj.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !seen.has(o as THREE.SkinnedMesh)) {
        seen.add(o as THREE.SkinnedMesh);
        out.push(o as THREE.SkinnedMesh);
      }
    });
  }
  return out;
}

/** Pristine inverse binds per donor SkinnedMesh. The remap overwrites
 *  boneInverses in place, so every re-sync (wearing another part of the same
 *  donor, undo/redo) must remap from the ORIGINAL donor matrices — feeding the
 *  already-remapped ones back in would apply the transform twice and garble
 *  the mesh. */
const PRISTINE_IBMS = new WeakMap<THREE.Skeleton, THREE.Matrix4[]>();

function pristineInverses(skel: THREE.Skeleton): THREE.Matrix4[] {
  const cached = PRISTINE_IBMS.get(skel);
  if (cached) return cached;
  const snapshot = skel.boneInverses.map((m) => new THREE.Matrix4().copy(m));
  PRISTINE_IBMS.set(skel, snapshot);
  return snapshot;
}

// Scratch matrices for the rebind math (single-threaded, sequential use).
const _ibmNew = new THREE.Matrix4();
const _ride = new THREE.Matrix4();
const _rideA = new THREE.Matrix4();
const _rideC = new THREE.Matrix4();
const _rideP = new THREE.Vector3();
const _rideP2 = new THREE.Vector3();
const _rideB = new THREE.Matrix4();
const _rideS = new THREE.Matrix4();
const _rideRight = new THREE.Matrix4();

/**
 * Which parts of the CURRENT model are replaced by worn donor parts: every
 * part whose category is worn by a donor (same-category originals hide). The
 * ambiguous "other" category never auto-replaces.
 */
export function computeReplaced(
  vrm: VRM | null,
  worn: WornRef[],
): { replacedMeshes: string[]; replacedParts: string[] } {
  if (!vrm || worn.length === 0) return { replacedMeshes: [], replacedParts: [] };
  const cats = new Set<PartCategory>(
    worn.map((w) => w.category).filter((c) => (AUTO_REPLACE_CATEGORIES as string[]).includes(c)),
  );
  if (cats.size === 0) return { replacedMeshes: [], replacedParts: [] };
  const replacedMeshes: string[] = [];
  const replacedParts: string[] = [];
  for (const p of [...collectParts(vrm), ...collectWholeMeshes(vrm)]) {
    if (!cats.has(p.category)) continue;
    (isPrimitiveId(p.id) ? replacedParts : replacedMeshes).push(p.id);
  }
  return { replacedMeshes, replacedParts };
}

// --- per-frame sync ---

const _m = new THREE.Matrix4();
const _mp = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * Copy world transforms from the target's humanoid RAW bones to every worn
 * donor's matching RAW bones, then step the donors' springbones. Call AFTER
 * the target's pose + vrm.update + hips lift, BEFORE render (this updates the
 * target's world matrices, render updates them again).
 */
export function updateWornParts(dt: number, target: VRM | null): void {
  if (!target || attached.size === 0) return;
  target.scene.updateMatrixWorld(true); // reads below need current worlds

  for (const a of attached.values()) {
    if (a.target !== target) {
      a.target = target;
      a.pairs = [];
      for (const bone of BONE_ORDER) {
        const t = target.humanoid?.getRawBoneNode(bone as never);
        const d = a.donor.vrm.humanoid?.getRawBoneNode(bone as never);
        if (t && d) a.pairs.push([t, d]);
      }
    }
    for (const [t, d] of a.pairs) {
      // donor-local = parentWorld⁻¹ · targetWorld — world-space copy absorbs
      // VRM 0.x root rotations and rest-pose differences between models.
      const parent = d.parent;
      if (!parent) continue;
      parent.updateWorldMatrix(true, false);
      _mp.copy(parent.matrixWorld).invert();
      _m.multiplyMatrices(_mp, t.matrixWorld);
      _m.decompose(_p, _q, _s);
      d.position.copy(_p);
      d.quaternion.copy(_q);
    }
    a.donor.vrm.scene.updateMatrixWorld(true); // springbones read raw worlds
    if (a.needsSpringReset) {
      // Snap the sub-bone chains + verlet state onto the current
      // (post-sync) configuration.
      a.needsSpringReset = false;
      rideSubBones(a, target);
      a.donor.vrm.springBoneManager?.setInitState();
      a.donor.vrm.springBoneManager?.reset();
    }
    a.donor.vrm.springBoneManager?.update(dt);
  }
}

/**
 * Re-anchor the local transform of every donor sub-bone that hangs directly
 * off a humanoid bone (chain roots — hair tufts, skirt spring roots…) so the
 * chain rides the world-space ride map `M` (rideWorld): its runtime world
 * becomes `M · RestJ_d` instead of the naive parent-follow
 * `A_t_runtime · RestA_d⁻¹ · RestJ_d`.
 *
 * The ride also SCALES the chain by the anchor bone's length ratio
 * (target/donor) — hair authored for a smaller head still covers a bigger
 * head, skirt chains follow the hips. Without it, cross-model hair renders as
 * a too-small cap floating on the target's head.
 *
 * The humanoid bones are world-synced onto the target, but a sub-bone chain
 * below them keeps its DONOR-local offsets — which are expressed in the
 * donor's file frame, facing the opposite way for VRM 0.x donors. Without
 * this compensation a VRM 0.x donor's hair/skirt springs render on the wrong
 * side of the target's head/body (and the naive frame-conjugated variant
 * collapses the chain, because the donor's joint frames are not
 * world-aligned). The compensated root flips and resizes the whole subtree
 * while keeping the chain's internal shape (deeper bones are untouched — they
 * ride the compensated root rigidly), and the donor binds stay valid
 * (sub-bone IBMs are left unchanged — see rebindWornMeshes). Computed from
 * the pristine rest captures, so it is idempotent across re-attachments.
 * `setInitState` afterwards re-anchors the spring stiffness to the
 * compensated rest.
 */
function rideSubBones(a: AttachedDonor, target: VRM): void {
  const vrm = a.donor.vrm;
  const targetRest = TARGET_REST.get(target);
  if (!targetRest) return;
  const cRotTarget = conventionRotation((target.meta as { metaVersion?: string } | undefined)?.metaVersion);
  const relR = conventionRotation((vrm.meta as { metaVersion?: string } | undefined)?.metaVersion);
  // Donor humanoid node → canonical bone name (TARGET_REST is keyed by it).
  const nodeToName = new Map<THREE.Object3D, string>();
  for (const bone of BONE_ORDER) {
    const node = vrm.humanoid?.getRawBoneNode(bone as never);
    if (node) nodeToName.set(node, bone);
  }
  const humanoidNodes = new Set<THREE.Object3D>(nodeToName.keys());
  vrm.scene.traverse((o) => {
    if (!(o as THREE.Bone).isBone || humanoidNodes.has(o)) return;
    // Walk up to the nearest bone ancestor: compensate only when it is the
    // humanoid bone itself (chain roots). Deeper bones ride their
    // compensated parent.
    let p: THREE.Object3D | null = o.parent;
    while (p && !(p as THREE.Bone).isBone && !humanoidNodes.has(p)) p = p.parent;
    if (!p || !humanoidNodes.has(p)) return;
    const ancestorName = nodeToName.get(p);
    const restJ = a.donor.restNodes.get(o);
    const restA_donor = a.donor.restNodes.get(p);
    const restA_target = ancestorName ? targetRest.get(ancestorName) : undefined;
    if (!ancestorName || !restJ || !restA_donor || !restA_target) return;

    // Anchor scale = the anchor bone's segment length ratio (target/donor):
    // the distance from the anchor joint to its humanoid parent joint
    // approximates the part size the chain hangs off (head size for hair,
    // hip size for skirt chains).
    const parentName = humanoidParentOf(p, nodeToName);
    let scale = 1;
    if (parentName) {
      const parentTargetNode = target.humanoid?.getRawBoneNode(parentName as never);
      const parentDonorRest = a.donor.restNodes.get(p);
      if (parentTargetNode && parentDonorRest) {
        parentTargetNode.updateWorldMatrix(true, false);
        const aPos = new THREE.Vector3().setFromMatrixColumn(p.matrixWorld, 3);
        const pT = new THREE.Vector3().setFromMatrixColumn(parentTargetNode.matrixWorld, 3);
        const aD = new THREE.Vector3().setFromMatrixColumn(restA_donor, 3);
        const pD = new THREE.Vector3().setFromMatrixColumn(parentDonorRest, 3);
        const donorLen = aD.distanceTo(pD);
        const targetLen = aPos.distanceTo(pT);
        if (donorLen > 1e-6) scale = targetLen / donorLen;
      }
    }

    // local_new = A_t_runtime⁻¹ · M_s · RestJ_d — from the pristine captures,
    // so repeated attachments don't accumulate transforms.
    rideWorld(_ride, cRotTarget, restA_target, restA_donor, relR, scale);
    _ride.premultiply(_rideA.copy(A_tRuntimeWorld(cRotTarget, restA_target)).invert());
    _ride.multiply(restJ);
    _ride.decompose(o.position, o.quaternion, o.scale);
  });
}

/** The nearest humanoid parent bone name above `node` (null when none). */
function humanoidParentOf(
  node: THREE.Object3D,
  nodeToName: Map<THREE.Object3D, string>,
): string | null {
  for (let cur: THREE.Object3D | null | undefined = node.parent; cur; cur = cur.parent) {
    const name = nodeToName.get(cur);
    if (name) return name;
  }
  return null;
}

/** The target humanoid joint's runtime rest world: cRot_target · file rest. */
function A_tRuntimeWorld(cRotTarget: THREE.Matrix4, restFile: THREE.Matrix4): THREE.Matrix4 {
  return _rideC.multiplyMatrices(cRotTarget, restFile);
}
