// Wardrobe live wearing: declarative worn state ("donor X, part Y") reconciled
// onto the scene, plus the per-frame sync that makes worn donor meshes follow
// the current model's skeleton.
//
// The donor's own VRM scene is attached under a wardrobeRoot group next to the
// main model — no cloning, so donor VRM APIs (springbones) keep working. At
// wear time each worn donor SkinnedMesh gets its inverse bind matrices
// remapped onto the target skeleton (bake.ts remapSkin — the SAME math the
// export uses, so the preview always matches the saved file). Every frame each
// shared humanoid RAW bone's world position+rotation is copied from the target
// to the donor (skinned meshes bind to raw bones; world-space copying absorbs
// VRM 0.x root rotations and rest-pose differences). Donor sub-bones outside
// the humanoid map (VRoid "J_Sec_" hair chains) follow their parents rigidly,
// and the donor's springbone manager is stepped afterwards so hair keeps its
// sway.

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
import { conventionRotation, relativeRotation, remapSkin } from './bake';
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

// --- attached donor scenes ---

interface AttachedDonor {
  donor: DonorSource;
  /** Bone pairs cached per target model (raw humanoid bones, world-synced). */
  target: VRM | null;
  pairs: [THREE.Object3D, THREE.Object3D][];
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
      a = { donor, target: null, pairs: [] };
      attached.set(name, a);
    }
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

/**
 * Remap the inverse bind matrices of the donor's worn SkinnedMeshes onto the
 * target skeleton (shared remapSkin math — same as the export bakes). Joints
 * that ARE donor humanoid bones remap onto the target's matching bone; donor
 * sub-bones (J_Sec_…) keep their own bind and follow their synced parents.
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

  const relR = relativeRotation(
    (target.meta as { metaVersion?: string } | undefined)?.metaVersion,
    (donor.vrm.meta as { metaVersion?: string } | undefined)?.metaVersion,
  );

  for (const mesh of wornSkinnedMeshes(donor, wornIds)) {
    const skel = mesh.skeleton;
    if (!skel) continue;
    const inputs = skel.bones.map((b, i) => {
      const name = nodeToName.get(b);
      const rest = name ? donor.restWorlds.get(name) : undefined;
      if (!name || !rest) {
        // Sub-bone (or unknown): keep the donor-side joint as-is.
        return { humanoidName: null, donorRest: new THREE.Matrix4(), donorIBM: skel.boneInverses[i] ?? new THREE.Matrix4() };
      }
      return { humanoidName: name, donorRest: rest, donorIBM: skel.boneInverses[i] ?? new THREE.Matrix4() };
    });
    const remap = remapSkin(inputs, targetRest, relR);
    remap.target.forEach((bone, i) => {
      if (bone != null && skel.boneInverses[i]) skel.boneInverses[i].copy(remap.ibm[i]);
    });
  }
}

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
    a.donor.vrm.springBoneManager?.update(dt);
  }
}
