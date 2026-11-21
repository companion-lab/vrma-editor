// Live model editing: applies ModelEdits directly to the loaded three.js VRM
// so edits preview immediately. The same edits are stored in the editor state
// and re-applied to the original file's glTF JSON on export (exportModel.ts).

import type { VRM } from '@pixiv/three-vrm';
import type { MaterialEdit, ModelEdits } from '../../store';
import { BONE_ORDER } from '../humanoid';
import { applyAssetVisibilityAll } from './parts';
import {
  BODY_SHAPE_LENGTH,
  BODY_SHAPE_GIRTH,
  BODY_SHAPE_UNIFORM,
  COMPENSATE_CHILD_SCALE,
  EDITABLE_BONES,
  LENGTH_AXIS_CHILD,
  THICKEN_BONES,
  bodyShapeLengthFactor,
  legLengthFactor,
  type BodyShapeParam,
} from './proportions';
import { EYE_ADJ_BONES, materialGroup } from './appearance';
import {
  DoubleSide,
  FrontSide,
  TextureLoader,
  type Color,
  type Material,
  type Mesh as TMesh,
  type Object3D,
  type Side,
  type Texture,
} from 'three';

// three-vrm splits MToon materials into "<name>" and "<name> (Outline)"
// instances; both map to the same glTF material.
export function stripOutlineSuffix(name: string): string {
  return name.replace(/ \(Outline\)$/, '');
}

export function collectMaterials(vrm: VRM): Material[] {
  const out: Material[] = [];
  if (vrm.materials) return vrm.materials;
  vrm.scene.traverse((o) => {
    const mat = (o as TMesh).material;
    if (Array.isArray(mat)) out.push(...mat);
    else if (mat) out.push(mat);
  });
  return out;
}

export function materialsFor(vrm: VRM, matName: string): Material[] {
  return collectMaterials(vrm).filter((m) => stripOutlineSuffix(m.name) === matName);
}

// --- Materials ---

interface MatSnapshot {
  color?: [number, number, number];
  emissive?: [number, number, number];
  opacity: number;
  transparent: boolean;
  alphaTest: number;
  side: Side;
  map?: Texture;
}
const MAT_SNAPSHOTS = new WeakMap<Material, MatSnapshot>();

// Materials may or may not carry color/emissive/map (three Material is a base
// class) — access them through these narrow casts.
type ColorMat = Material & { color: Color };
type EmissiveMat = Material & { emissive: Color };
type MapMat = Material & { map?: Texture };

function asColorMat(m: Material): ColorMat | null {
  return 'color' in m ? (m as ColorMat) : null;
}
function asEmissiveMat(m: Material): EmissiveMat | null {
  return 'emissive' in m ? (m as EmissiveMat) : null;
}
function asMapMat(m: Material): MapMat | null {
  return 'map' in m ? (m as MapMat) : null;
}

/** Capture original material values so "reset" can undo live mutations. Call once after load. */
export function snapshotMaterials(vrm: VRM): void {
  for (const m of collectMaterials(vrm)) {
    if (MAT_SNAPSHOTS.has(m)) continue;
    const snap: MatSnapshot = {
      opacity: m.opacity,
      transparent: m.transparent,
      alphaTest: m.alphaTest,
      side: m.side,
    };
    const color = asColorMat(m);
    if (color) snap.color = [color.color.r, color.color.g, color.color.b];
    const emissive = asEmissiveMat(m);
    if (emissive) snap.emissive = [emissive.emissive.r, emissive.emissive.g, emissive.emissive.b];
    const mapMat = asMapMat(m);
    if (mapMat) snap.map = mapMat.map;
    MAT_SNAPSHOTS.set(m, snap);
  }
}

/** Restore a material's original look and drop its edit record. */
export function resetMaterialLive(vrm: VRM, matName: string): void {
  for (const m of materialsFor(vrm, matName)) {
    const snap = MAT_SNAPSHOTS.get(m);
    if (!snap) continue;
    const color = asColorMat(m);
    if (snap.color && color) color.color.setRGB(snap.color[0], snap.color[1], snap.color[2]);
    const emissive = asEmissiveMat(m);
    if (snap.emissive && emissive) emissive.emissive.setRGB(snap.emissive[0], snap.emissive[1], snap.emissive[2]);
    m.opacity = snap.opacity;
    m.transparent = snap.transparent;
    m.alphaTest = snap.alphaTest;
    m.side = snap.side;
    const mapMat = asMapMat(m);
    if (mapMat) mapMat.map = snap.map;
    m.needsUpdate = true;
  }
}

/** Restore only a material's original base texture (undo of a texture replacement). */
export function restoreMaterialTexture(vrm: VRM, matName: string): void {
  for (const m of materialsFor(vrm, matName)) {
    const snap = MAT_SNAPSHOTS.get(m);
    const mapMat = asMapMat(m);
    if (!snap || !mapMat || mapMat.map === snap.map) continue;
    mapMat.map = snap.map;
    m.needsUpdate = true;
  }
}

/** Apply one material's edit patch to the live materials. */
export function applyMaterialEdit(vrm: VRM, matName: string, edit: MaterialEdit): void {
  for (const m of materialsFor(vrm, matName)) {
    const color = asColorMat(m);
    if (edit.color && color) color.color.setRGB(edit.color[0], edit.color[1], edit.color[2]);
    const emissive = asEmissiveMat(m);
    if (edit.emissive && emissive) emissive.emissive.setRGB(edit.emissive[0], edit.emissive[1], edit.emissive[2]);
    if (edit.opacity !== undefined) m.opacity = edit.opacity;
    if (edit.alphaMode) {
      // glTF alpha modes → three.js flags (same mapping GLTFLoader uses).
      if (edit.alphaMode === 'BLEND') {
        m.transparent = true;
        m.alphaTest = 0;
      } else if (edit.alphaMode === 'MASK') {
        m.transparent = false;
        m.alphaTest = 0.5;
      } else {
        m.transparent = false;
        m.alphaTest = 0;
      }
    }
    if (edit.doubleSided !== undefined) {
      m.side = edit.doubleSided ? DoubleSide : FrontSide;
    }
    m.needsUpdate = true;
  }
}

/** Load an image file as a texture and swap it in as the base color texture. */
export async function applyTextureReplacement(vrm: VRM, matName: string, file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    const tex = await new TextureLoader().loadAsync(url);
    // glTF textures are decoded with flipY=false (UV convention).
    tex.flipY = false;
    tex.colorSpace = 'srgb';
    tex.name = file.name;
    for (const m of materialsFor(vrm, matName)) {
      (m as MapMat).map = tex;
      m.needsUpdate = true;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Small square data-URL preview of a material's current base texture (null if none). */
export function textureThumbDataUrl(vrm: VRM, matName: string, size = 48): string | null {
  const map = (materialsFor(vrm, matName)[0] as MapMat | undefined)?.map;
  const img = map?.image as (ImageBitmap | HTMLImageElement | undefined) | undefined;
  if (!img) return null;
  const iw = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const ih = 'naturalHeight' in img ? img.naturalHeight : img.height;
  if (!iw || !ih) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // cover-fit into the square
    const scale = Math.max(size / iw, size / ih);
    const w = iw * scale;
    const h = ih * scale;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL('image/png');
  } catch {
    return null; // tainted canvas or undrawable image
  }
}

// --- Meshes ---

/** Unique mesh display names, sorted. Multi-primitive nodes share one name. */
export function collectMeshNames(vrm: VRM): string[] {
  const names = new Set<string>();
  vrm.scene.traverse((o) => {
    if ((o as TMesh).isMesh && o.name) names.add(o.name);
  });
  return [...names].sort((a, b) => a.localeCompare(b));
}

// (Whole-mesh + per-primitive visibility moved to parts.ts applyAssetVisibilityAll,
// which combines both lists so merged meshes and their primitives never fight
// over .visible.)

/**
 * Point MToon outline material groups at their fill material.
 *
 * VRoid-style meshes ship the outline as a SECOND material group covering the
 * whole primitive. The outline shader ignores the main texture's alpha, so
 * garment regions the fill pass discards (hidden layers whose texels are
 * fully transparent — e.g. AvatarSample_B's coat-skirt lining) would still
 * render solid through the outline. Rendering those groups with the fill
 * material makes both passes discard identically; visible parts keep their
 * outlines (the outline shell sits ~2mm outside the surface and samples the
 * same texels, so the difference is imperceptible).
 */
export function collapseOutlineMaterialGroups(vrm: VRM): void {
  vrm.scene.traverse((o) => {
    const mesh = o as TMesh;
    if (!mesh.isMesh || !Array.isArray(mesh.material)) return;
    const mats = mesh.material;
    const fill = mats.find((m) => m && !(m as MToonLike).isOutline);
    if (!fill) return;
    if (!mats.some((m) => m && (m as MToonLike).isOutline)) return;
    mesh.material = mats.map((m) => ((m as MToonLike).isOutline ? fill : m));
  });
}

interface MToonLike {
  isOutline?: boolean;
  alphaTest?: number;
  uniforms?: { alphaTest?: { value: number } };
}

/**
 * Keep MToon's `alphaTest` shader uniform in sync with the material property.
 * Some parses initialize the uniform to 0 even when material.alphaTest is set,
 * and the MToon shader discards against the UNIFORM — garments with
 * alpha-hidden layers (transparent texels, e.g. AvatarSample_B's coat-skirt
 * lining) would then render solid. Syncing here is idempotent and cheap.
 */
export function syncMToonUniforms(vrm: VRM): void {
  vrm.scene.traverse((o) => {
    const mesh = o as TMesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const mt = m as MToonLike;
      const uniform = mt.uniforms?.alphaTest;
      if (uniform && typeof mt.alphaTest === 'number') uniform.value = mt.alphaTest;
    }
  });
}

// --- Expressions ---

export function expressionNames(vrm: VRM): string[] {
  const map = vrm.expressionManager?.expressionMap;
  if (!map) return [];
  return Object.keys(map);
}

export function applyExpressionWeight(vrm: VRM, name: string, weight: number): void {
  vrm.expressionManager?.setValue(name, weight);
}

// --- Bone scale (proportions) ---
// The bone behaviour config lives in ./proportions (shared with exportModel.ts).

/** Local axis (0=x, 1=y, 2=z) a bone points along, judged from the first
 *  canonical child bone that is a direct child; falls back to the
 *  largest-offset child, then Y. */
function boneLengthAxis(vrm: VRM, bone: string, node: Object3D): 0 | 1 | 2 {
  let probe: Object3D | undefined;
  for (const name of LENGTH_AXIS_CHILD[bone] ?? []) {
    const candidate = rawBoneNode(vrm, name);
    if (candidate && candidate.parent === node) {
      probe = candidate;
      break;
    }
  }
  probe ??= node.children.reduce<Object3D | undefined>(
    (a, b) => (b.position.lengthSq() > (a?.position.lengthSq() ?? 0) ? b : a),
    undefined,
  );
  if (!probe) return 1;
  const ax = Math.abs(probe.position.x);
  const ay = Math.abs(probe.position.y);
  const az = Math.abs(probe.position.z);
  return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
}

interface NodeRest {
  pos: [number, number, number];
  scale: [number, number, number];
}
const NODE_REST = new WeakMap<Object3D, NodeRest>();

/** Original (file) transform of a node — captured the first time anything touches it. */
function nodeRest(node: Object3D): NodeRest {
  let rest = NODE_REST.get(node);
  if (!rest) {
    rest = {
      pos: [node.position.x, node.position.y, node.position.z],
      scale: [node.scale.x, node.scale.y, node.scale.z],
    };
    NODE_REST.set(node, rest);
  }
  return rest;
}

function rawBoneNode(vrm: VRM, bone: string): Object3D | null {
  return (vrm.humanoid?.getRawBoneNode(bone as never) as Object3D | undefined) ?? null;
}

/**
 * Apply the full boneScale edit map to the model. Resets every editable bone
 * (and the children that compensation touches) to the file's rest transform
 * first, then applies each factor parents-first on top of current values — so
 * the result is idempotent, and adjacent segments compose cleanly (a ×1.2
 * upper arm and ×1.3 forearm give a ×1.3 forearm, never ×1.56). Torso & limb
 * factors thicken their part (girth only, length axis untouched); head/hands/
 * hips/feet scale the whole part.
 *
 * `bodyShape` (optional) applies the VRoid-style semantic layer on top: girth
 * and whole-part factors (same two patterns) plus LENGTH scaling — the bone's
 * length axis grows and only the children's scale on that axis is divided
 * back, so the child joints ride outward with the stretched flesh and the
 * limb actually gets longer.
 */
export function applyAllBoneScales(
  vrm: VRM,
  boneScale: Record<string, number>,
  bodyShape?: Record<string, number>,
): void {
  if (!vrm.humanoid) return;

  // 1) restore file rest for editable bones and the children compensation touches
  for (const bone of EDITABLE_BONES) {
    const node = rawBoneNode(vrm, bone);
    if (!node) continue;
    const rest = nodeRest(node);
    node.position.set(rest.pos[0], rest.pos[1], rest.pos[2]);
    node.scale.set(rest.scale[0], rest.scale[1], rest.scale[2]);
    for (const child of node.children) {
      const cr = nodeRest(child);
      child.position.set(cr.pos[0], cr.pos[1], cr.pos[2]);
      child.scale.set(cr.scale[0], cr.scale[1], cr.scale[2]);
    }
  }

  // 2) apply edited factors, parents before children (BONE_ORDER is depth-first)
  for (const bone of BONE_ORDER) {
    const factor = boneScale[bone];
    if (factor == null || Math.abs(factor - 1) < 0.005) continue;
    const node = rawBoneNode(vrm, bone);
    if (!node) continue;

    if (THICKEN_BONES.has(bone)) {
      // thicken in place: grow the two axes perpendicular to the bone's length
      // and divide the children's scale/position on the grown axes so the
      // joints stay put and child parts don't inherit the girth
      const axis = boneLengthAxis(vrm, bone, node);
      const fx = axis === 0 ? 1 : factor;
      const fy = axis === 1 ? 1 : factor;
      const fz = axis === 2 ? 1 : factor;
      node.scale.set(node.scale.x * fx, node.scale.y * fy, node.scale.z * fz);
      for (const child of node.children) {
        child.scale.set(child.scale.x / fx, child.scale.y / fy, child.scale.z / fz);
        child.position.set(child.position.x / fx, child.position.y / fy, child.position.z / fz);
      }
    } else {
      // head / hands / feet / hips (whole body): scale the whole part
      node.scale.multiplyScalar(factor);
      if (COMPENSATE_CHILD_SCALE.has(bone)) {
        for (const child of node.children) child.scale.divideScalar(factor);
      }
    }
  }

  if (bodyShape) applyBodyShape(vrm, bodyShape);
}

/** The VRoid-style semantic layer: girth (thicken), whole-part uniform scales
 *  and length scaling, applied after the per-bone boneScale pass. */
function applyBodyShape(vrm: VRM, bodyShape: Record<string, number>): void {
  // Girth + whole-part factors — the same two patterns as the boneScale pass.
  for (const [param, value] of Object.entries(bodyShape)) {
    if (value == null || Math.abs(value - 1) < 0.005) continue;
    const girth = BODY_SHAPE_GIRTH[param as BodyShapeParam];
    const uniform = BODY_SHAPE_UNIFORM[param as BodyShapeParam];
    for (const bone of [...(girth ?? []), ...(uniform ?? [])]) {
      const node = rawBoneNode(vrm, bone);
      if (!node) continue;
      if (girth?.includes(bone)) {
        const axis = boneLengthAxis(vrm, bone, node);
        const fx = axis === 0 ? 1 : value;
        const fy = axis === 1 ? 1 : value;
        const fz = axis === 2 ? 1 : value;
        node.scale.set(node.scale.x * fx, node.scale.y * fy, node.scale.z * fz);
        for (const child of node.children) {
          child.scale.set(child.scale.x / fx, child.scale.y / fy, child.scale.z / fz);
          child.position.set(child.position.x / fx, child.position.y / fy, child.position.z / fz);
        }
      } else {
        node.scale.multiplyScalar(value);
        if (COMPENSATE_CHILD_SCALE.has(bone)) {
          for (const child of node.children) child.scale.divideScalar(value);
        }
      }
    }
  }

  // Length pass — parents first. Grow the bone's length axis; only the
  // children's scale on that axis is divided back, so their joints ride
  // outward with the stretched flesh and the limb actually gets longer.
  for (const bone of BONE_ORDER) {
    for (const [param, bones] of Object.entries(BODY_SHAPE_LENGTH)) {
      if (!bones.includes(bone)) continue;
      const value = bodyShape[param];
      if (value == null || Math.abs(value - 1) < 0.005) continue;
      const factor = bodyShapeLengthFactor(param as BodyShapeParam, value, bone);
      if (Math.abs(factor - 1) < 0.005) continue;
      const node = rawBoneNode(vrm, bone);
      if (!node) continue;
      const axis = boneLengthAxis(vrm, bone, node);
      const fx = axis === 0 ? factor : 1;
      const fy = axis === 1 ? factor : 1;
      const fz = axis === 2 ? factor : 1;
      node.scale.set(node.scale.x * fx, node.scale.y * fy, node.scale.z * fz);
      for (const child of node.children) {
        child.scale.set(child.scale.x / fx, child.scale.y / fy, child.scale.z / fz);
      }
    }
  }
}

/**
 * Vertical hips offset (metres) that keeps the feet planted when the legs
 * grow: whole-body hips scaling (the per-bone Proportions slider) sinks the
 * model by the leg-length growth, and so do the VRoid-style height / leg
 * length sliders — each lifts the hips by exactly its own leg growth.
 */
export function hipsLiftOffset(
  boneScale: Record<string, number>,
  bodyShape: Record<string, number> | undefined,
  restHipsY: number,
  restFeetY: number,
): number {
  const span = Math.max(0, restHipsY - restFeetY);
  let lift = 0;
  const hipsFactor = boneScale.hips ?? 1;
  if (Math.abs(hipsFactor - 1) > 0.005) lift += (hipsFactor - 1) * span;
  if (bodyShape) {
    const legFactor = legLengthFactor(bodyShape);
    if (Math.abs(legFactor - 1) > 0.005) lift += (legFactor - 1) * span;
  }
  return lift;
}

/**
 * Add the whole-body lift to the hips node. Call after `vrm.update()` each
 * frame: the humanoid sync rewrites the hips position from the normalized rig
 * (which never sees the lift), so it must be re-applied every frame. The same
 * offset is baked into the hips translation on export.
 */
export function applyHipsLift(vrm: VRM, lift: number): void {
  const hips = rawBoneNode(vrm, 'hips');
  const parent = hips?.parent;
  // The offset is vertical in the parent's space — only safe when the hips
  // parent is unscaled and upright (the standard VRM rig).
  if (!hips || !parent) return;
  if (Math.abs(parent.scale.x - 1) > 1e-4 || Math.abs(parent.scale.y - 1) > 1e-4) return;
  if (lift !== 0) hips.position.y += lift;
}

// --- Face shape (VRoid eye-adjust bones) ---

/**
 * Apply the face-shape edits to the model's eye-adjust bones
 * (J_Adj_L/R_FaceEye — present on VRoid-exported models): eye size scales the
 * eye region, height/spacing nudge both eyes vertically / apart. Bones reset
 * to the file rest first, so the apply is idempotent. Models without the
 * bones (non-VRoid rigs) are unaffected.
 */
export function applyFaceShape(vrm: VRM, face: Record<string, number> | undefined): void {
  const s = face?.eyeSize ?? 1;
  const h = face?.eyeHeight ?? 0;
  const w = face?.eyeSpacing ?? 0;
  for (const boneName of EYE_ADJ_BONES) {
    const node = vrm.scene.getObjectByName(boneName);
    if (!node) continue;
    const rest = nodeRest(node);
    node.position.set(rest.pos[0], rest.pos[1], rest.pos[2]);
    node.scale.set(rest.scale[0], rest.scale[1], rest.scale[2]);
    if (Math.abs(s - 1) < 0.005 && Math.abs(h) < 0.001 && Math.abs(w) < 0.001) continue;
    const side = boneName.includes('_L_') ? 1 : -1;
    node.scale.multiplyScalar(s);
    node.position.x += side * w * 0.01; // metres, mirrored per eye
    node.position.y += h * 0.01;
  }
}

export function restBoneScale(vrm: VRM, bone: string): [number, number, number] {
  const node = rawBoneNode(vrm, bone);
  return node ? nodeRest(node).scale : [1, 1, 1];
}

export function boneHasNode(vrm: VRM, bone: string): boolean {
  return rawBoneNode(vrm, bone) != null;
}

// --- All-in-one ---

/** Apply every recorded edit to the live model (used after edits load or reset). */
export function applyAllEdits(vrm: VRM, edits: ModelEdits): void {
  applyAssetVisibilityAll(vrm, edits.hiddenMeshes, edits.hiddenParts);
  for (const [name, edit] of Object.entries(edits.materials)) {
    applyMaterialEdit(vrm, name, edit);
  }
  const manager = vrm.expressionManager;
  if (manager) {
    manager.resetValues();
    for (const [name, weight] of Object.entries(edits.expressions)) {
      manager.setValue(name, weight);
    }
  }
  applyAllBoneScales(vrm, edits.boneScale, edits.bodyShape);
  applyFaceShape(vrm, edits.face);
}

/**
 * Re-apply a restored ModelEdits to the live model after undo/redo. The bulk
 * goes through applyAllEdits — but that is idempotent on top of the file's
 * rest state, not self-resetting, so materials touched by the state being
 * left are reset to their snapshot first (visibility, expressions and bone
 * scale already reset themselves inside applyAllEdits). Texture replacements
 * are synced separately because they come from Files: one present in the
 * restored state is re-applied only when the live texture isn't already it
 * (matched by file name), and one that disappeared on restore puts the
 * original texture back.
 */
export function syncModelEdits(vrm: VRM, restored: ModelEdits, previous: ModelEdits): void {
  const touched = new Set([...Object.keys(previous.materials), ...Object.keys(restored.materials)]);
  for (const name of touched) resetMaterialLive(vrm, name);
  applyAllEdits(vrm, restored);
  const prevReplaced = new Set(
    Object.entries(previous.materials)
      .filter(([, e]) => e.textureFile)
      .map(([n]) => n),
  );
  for (const name of new Set([...prevReplaced, ...Object.keys(restored.materials)])) {
    const edit = restored.materials[name];
    if (edit?.textureFile) {
      const map = materialsFor(vrm, name)[0] as MapMat | undefined;
      if (map?.map && map.map.name === edit.textureName) continue;
      void applyTextureReplacement(vrm, name, edit.textureFile);
    } else if (prevReplaced.has(name)) {
      restoreMaterialTexture(vrm, name);
    }
  }
}
