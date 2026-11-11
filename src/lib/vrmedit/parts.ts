// Asset parts: per-primitive asset toggling for merged VRM meshes.
//
// Many VRM models (VRoid-style exports) merge every clothing/hair piece into a
// few multi-primitive meshes, so the whole-mesh "Meshes" toggle cannot switch
// outfits. three.js GLTFLoader loads each primitive of a multi-primitive mesh
// as its own child Mesh (the MToon outline is extra material groups on the same
// child), so hiding a primitive = hiding that child Object3D. Export removes
// the primitive from the glTF JSON (exportModel.ts applyHiddenParts).

import type { VRM } from '@pixiv/three-vrm';
import { Object3D, type Material, type Mesh as TMesh } from 'three';

/** Stable id of a glTF primitive: `<mesh index>:<primitive index>`. */
export type PartId = string;

export function partId(gltfMeshIndex: number, primitiveIndex: number): PartId {
  return `${gltfMeshIndex}:${primitiveIndex}`;
}

export function parsePartId(id: PartId): { mesh: number; primitive: number } | null {
  const m = id.match(/^(\d+):(\d+)$/);
  return m ? { mesh: Number(m[1]), primitive: Number(m[2]) } : null;
}

// --- Categories ---

export type PartCategory =
  | 'top'
  | 'bottom'
  | 'feet'
  | 'underwear'
  | 'hair'
  | 'face'
  | 'body'
  | 'accessory'
  | 'other';

export const CATEGORY_LABEL: Record<PartCategory, string> = {
  top: 'Top',
  bottom: 'Bottom',
  feet: 'Feet',
  underwear: 'Underwear',
  hair: 'Hair',
  face: 'Face',
  body: 'Body',
  accessory: 'Accessory',
  other: 'Other',
};

/** Display order of categories in the Assets panel (clothes first). */
export const CATEGORY_ORDER: PartCategory[] = [
  'top',
  'bottom',
  'feet',
  'underwear',
  'hair',
  'face',
  'body',
  'accessory',
  'other',
];

/** Guess the category of an asset part from its material / mesh name. */
export function classifyAsset(...names: (string | undefined)[]): PartCategory {
  // "_" is a regex word character, so \b keyword boundaries never match
  // VRoid-style "_Tops_"/"_Body_" tokens — normalize to spaces first.
  const s = names.filter(Boolean).join(' ').replace(/_/g, ' ');
  // Order matters: face skin ("Face_00_SKIN") must hit before body's skin,
  // underwear before the generic tops/bottoms words.
  if (/hair/i.test(s)) return 'hair';
  if (/face|\beye|iris|eyeline|mouth|brow|lash|teeth|tongue|cheek|\bnose\b/i.test(s)) return 'face';
  if (/underwear|\bbra\b|panties|briefs|\binner\b|under tops?|under bottoms?/i.test(s)) return 'underwear';
  if (/onepiece|\btops?\b|\bshirt|blouse|jacket|hoodie|coat|cardigan|sweater|\bvest\b|dress|\bsuit\b|parka|uniform|clothes/i.test(s))
    return 'top';
  if (/bottoms?|\bpants?\b|skirt|shorts|trousers|jeans|tights|culottes/i.test(s)) return 'bottom';
  if (/\bshoes?\b|\bboots\b|sandals|\bsocks?\b|heels|loafers|\bfeet\b|pumps/i.test(s)) return 'feet';
  if (/accessor|\bacc\b|\bhat\b|\bcap\b|ribbon|glasses|eyewear|headwear|glove|\bbelt\b|\bbag\b|wings|\btail\b|earring|necklace|\btie\b|scarf|ornament/i.test(s))
    return 'accessory';
  if (/\bbody\b|\bskin\b/i.test(s)) return 'body';
  return 'other';
}

// --- Labels ---

const DECORATION = /\s*\((?:Instance|Outline|merged|Clone)\)/gi;
const CAMEL_SPLIT = /([a-z0-9])([A-Z])/g;

/** Clean a material name: strip "(Instance)" / "(Outline)" decorations. */
function cleanMaterialName(raw: string | undefined): string {
  return (raw ?? '').replace(/\s*\((?:Instance|Outline)\)\s*$/i, '').trim();
}

/** Clean a three.js mesh name: "(merged)", "(Clone)", ".baked", unique "_N" suffixes. */
export function cleanMeshName(raw: string | undefined): string {
  let s = (raw ?? '').replace(DECORATION, '').trim();
  s = s.replace(/_(?:\d+)$/, ''); // GLTFLoader unique-name suffix
  s = s.replace(/\.baked\b/gi, '').trim();
  return s;
}

/**
 * Human label for an asset part. Understands VRoid/N-DDS style material names
 * (`N00_010_01_Onepiece_00_CLOTH` → "Onepiece", `N00_000_Hair_00_HAIR_01` →
 * "Hair 01"). Tries each name in order (material first); falls back to a
 * cleaned mesh name.
 */
export function assetLabel(...raws: (string | undefined)[]): string {
  for (const raw of raws) {
    const s = cleanMaterialName(raw);
    if (!s) continue;
    const vroid = s.match(/^N\d+_\d+_(?:\d+_)?(.+?)_(\d+)_([A-Za-z]+)(?:_(\d+))?$/);
    if (vroid) {
      const item = vroid[1].replace(/_/g, ' ').replace(CAMEL_SPLIT, '$1 $2').trim();
      return vroid[4] ? `${item} ${vroid[4]}` : item;
    }
  }
  // Fallback: cleaned mesh name, else the raw name with junk tokens dropped.
  for (const raw of raws) {
    const s = cleanMeshName(raw);
    if (s) return s.replace(CAMEL_SPLIT, '$1 $2').trim();
  }
  return 'Asset';
}

// --- Association registry (filled by Viewport at load time) ---

interface PartAssoc {
  meshes: number;
  primitives?: number;
}

const PART_ASSOC = new WeakMap<VRM, Map<Object3D, PartAssoc>>();

/**
 * Capture the GLTFLoader association map (three.js object → glTF indices) so
 * `collectParts` can map primitive children to their glTF mesh/primitive.
 */
export function registerPartAssociations(
  vrm: VRM,
  associations: Map<unknown, { meshes?: number; primitives?: number }>,
): void {
  const map = new Map<Object3D, PartAssoc>();
  for (const [obj, ref] of associations) {
    if (obj instanceof Object3D && ref.meshes != null) {
      map.set(obj, { meshes: ref.meshes, primitives: ref.primitives });
    }
  }
  PART_ASSOC.set(vrm, map);
}

/** A primitive child's surface material (slot 0; slot 1 is the MToon outline). */
function baseMaterial(obj: TMesh): Material | undefined {
  const mat = obj.material;
  return Array.isArray(mat) ? mat[0] : mat;
}

// --- Parts ---

export interface AssetPart {
  id: PartId;
  label: string;
  category: PartCategory;
  /** three.js name of the owning mesh node (shown as context in the UI). */
  meshName: string;
}

/**
 * Every drawable primitive of the model's multi-primitive meshes, one entry
 * each. Single-primitive meshes are handled by the whole-mesh hide list
 * (hiddenMeshes) and are NOT included here.
 */
export function collectParts(vrm: VRM): AssetPart[] {
  const assoc = PART_ASSOC.get(vrm);
  if (!assoc) return [];

  // Multi-primitive meshes in glTF load as a Group of primitive Meshes; count
  // meshes per glTF mesh index to tell the two shapes apart.
  const byMesh = new Map<number, Object3D[]>();
  for (const [obj, ref] of assoc) {
    if ((obj as TMesh).isMesh) {
      const list = byMesh.get(ref.meshes) ?? [];
      list.push(obj);
      byMesh.set(ref.meshes, list);
    }
  }

  const parts: AssetPart[] = [];
  for (const [, objects] of byMesh) {
    if (objects.length <= 1) continue; // single-primitive mesh → whole-mesh toggle
    for (const obj of objects) {
      const ref = assoc.get(obj);
      if (ref?.primitives == null) continue;
      const matName = cleanMaterialName(baseMaterial(obj as TMesh)?.name);
      parts.push({
        id: partId(ref.meshes, ref.primitives),
        label: assetLabel(matName, obj.name),
        category: classifyAsset(matName, obj.name),
        meshName: cleanMeshName(obj.name),
      });
    }
  }
  parts.sort((a, b) => a.meshName.localeCompare(b.meshName) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return parts;
}

/**
 * Whole-mesh entries for the model's single-primitive meshes (Face, simple
 * props…). Their id is the three.js mesh name (the whole-mesh hide list key).
 */
export function collectWholeMeshes(vrm: VRM): AssetPart[] {
  const assoc = PART_ASSOC.get(vrm);
  if (!assoc) return [];

  const primsByMesh = new Map<number, Object3D[]>();
  for (const [obj, ref] of assoc) {
    if ((obj as TMesh).isMesh && ref.primitives != null) {
      const list = primsByMesh.get(ref.meshes) ?? [];
      list.push(obj);
      primsByMesh.set(ref.meshes, list);
    }
  }

  const out: AssetPart[] = [];
  const seen = new Set<string>();
  for (const [, objects] of primsByMesh) {
    if (objects.length !== 1) continue; // merged mesh → collectParts handles its primitives
    const obj = objects[0];
    if (!obj.name || seen.has(obj.name)) continue;
    seen.add(obj.name);
    const matName = cleanMaterialName(baseMaterial(obj as TMesh)?.name);
    out.push({
      id: obj.name,
      label: assetLabel(matName, obj.name),
      category: classifyAsset(matName, obj.name),
      meshName: '',
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

// --- Live visibility ---

/**
 * Apply BOTH visibility lists at once. Whole-mesh hides (single-primitive
 * meshes, or all primitives of a merged mesh) always win over per-primitive
 * shows, so the two toggle systems can never fight each other.
 */
export function applyAssetVisibilityAll(vrm: VRM, hiddenMeshes: string[], hiddenParts: PartId[]): void {
  const hiddenM = new Set(hiddenMeshes);
  const hiddenP = new Set(hiddenParts);
  const assoc = PART_ASSOC.get(vrm);

  // Primitive meshes grouped by glTF mesh index (groups/skins aren't Meshes).
  const primsByMesh = new Map<number, { obj: Object3D; prim: number }[]>();
  if (assoc) {
    for (const [obj, ref] of assoc) {
      if (!(obj as TMesh).isMesh || ref.primitives == null) continue;
      const list = primsByMesh.get(ref.meshes) ?? [];
      list.push({ obj, prim: ref.primitives });
      primsByMesh.set(ref.meshes, list);
    }
  }

  for (const [meshIndex, list] of primsByMesh) {
    if (list.length <= 1) {
      // single-primitive mesh → plain whole-mesh toggle
      list[0].obj.visible = !hiddenM.has(list[0].obj.name);
      continue;
    }
    for (const { obj, prim } of list) {
      obj.visible = !hiddenM.has(obj.name) && !hiddenP.has(partId(meshIndex, prim));
    }
  }
}

/** Live object for a part id, if it exists in this model. */
export function partObject(vrm: VRM, id: PartId): Object3D | null {
  const parsed = parsePartId(id);
  if (!parsed) return null;
  const assoc = PART_ASSOC.get(vrm);
  if (!assoc) return null;
  for (const [obj, ref] of assoc) {
    if (ref.meshes === parsed.mesh && ref.primitives === parsed.primitive && (obj as TMesh).isMesh) {
      return obj;
    }
  }
  return null;
}
