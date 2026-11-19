// Wardrobe donor sources: other VRM files loaded as sources of wearable parts
// (hair, top, pants, shoes…). A donor is loaded with the same pipeline as the
// main model (GLTFLoader + VRMLoaderPlugin) and its parts are classified with
// the existing Assets classifier, so the wardrobe UI is just "parts of another
// model, grouped by category". The original bytes are kept so "Save model" can
// bake worn parts into the exported file (bake.ts).

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { Matrix4 } from 'three';
import { BONE_ORDER } from '../humanoid';
import {
  collectParts,
  collectWholeMeshes,
  registerPartAssociations,
  type AssetPart,
  type PartCategory,
} from '../vrmedit/parts';

export interface DonorSource {
  name: string;
  url: string;
  vrm: VRM;
  /** Original file bytes — kept so export can merge worn parts (bake.ts). */
  bytes: ArrayBuffer;
  /** Every drawable part of the donor, classified like the Assets panel. */
  parts: AssetPart[];
  /** Humanoid bone name → FILE rest-pose world matrix (donor scene is kept
   *  unrotated, so this is the glTF file's own rest pose). */
  restWorlds: Map<string, Matrix4>;
}

const DONORS = new Map<string, DonorSource>();

/** Categories the wardrobe can swap. Face/body pieces are never wearable; the
 *  ambiguous "other" is listed but never auto-hides the target's own pieces. */
export const WEARABLE_CATEGORIES: PartCategory[] = [
  'hair',
  'top',
  'bottom',
  'feet',
  'underwear',
  'accessory',
  'other',
];

/** Wearing a part of one of these hides the target's own parts of the SAME
 *  category ("other" is deliberately absent — too ambiguous to auto-replace). */
export const AUTO_REPLACE_CATEGORIES: PartCategory[] = [
  'hair',
  'top',
  'bottom',
  'feet',
  'underwear',
  'accessory',
];

export function getDonor(name: string): DonorSource | undefined {
  return DONORS.get(name);
}

export function donorNames(): string[] {
  return [...DONORS.keys()];
}

/** Load (or return the already-loaded) donor `name` from `url`. When the bytes
 *  are already in hand (file picker / export), pass them to skip the fetch. */
export async function loadDonor(name: string, url: string, bytes?: ArrayBuffer): Promise<DonorSource> {
  const existing = DONORS.get(name);
  if (existing) return existing;

  if (!bytes) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${name}`);
    bytes = await res.arrayBuffer();
  }

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(bytes, '');
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error(`${name} is not a VRM file (no humanoid found)`);

  // Same post-load passes as the main model (Viewport.tsx) so skinning behaves
  // identically. rotateVRM0 is deliberately NOT applied: worn parts rebind into
  // the target model's space (bake.ts remapSkin handles the facing-convention
  // rotation), and the donor is never rendered standalone.
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  registerPartAssociations(vrm, gltf.parser.associations);

  // Capture the donor's humanoid rest pose (file space) while the bones are
  // still pristine — the per-frame bone sync overwrites them once worn.
  vrm.scene.updateMatrixWorld(true);
  const restWorlds = new Map<string, Matrix4>();
  for (const bone of BONE_ORDER) {
    const node = vrm.humanoid?.getRawBoneNode(bone as never);
    if (node) restWorlds.set(bone, new Matrix4().copy(node.matrixWorld));
  }

  const donor: DonorSource = {
    name,
    url,
    vrm,
    bytes,
    parts: [...collectParts(vrm), ...collectWholeMeshes(vrm)],
    restWorlds,
  };
  DONORS.set(name, donor);
  return donor;
}
