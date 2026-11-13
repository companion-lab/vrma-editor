// Model export: applies ModelEdits to the ORIGINAL file's glTF JSON and
// repacks the GLB. Editing the JSON (instead of re-exporting the three.js
// scene) preserves every VRM extension we don't touch — spring bones,
// constraints, MToon shaders, first-person, etc.

import type { MaterialEdit, ModelEdits } from '../../store';
import { BONE_ORDER } from '../humanoid';
import { appendImage, copyBin, mimeTypeFor, parseGlb, writeGlb } from './glb';
import { parsePartId } from './parts';
import { COMPENSATE_CHILD_SCALE, LENGTH_AXIS_CHILD, THICKEN_BONES } from './proportions';

// VRM 0.x blendshape preset names ↔ VRM 1.0 expression presets.
// Mirrors three-vrm's v0v1PresetNameMap so names seen in the editor
// (always VRM 1.0 naming) map back to the file's own format on export.
const V0_TO_V1: Record<string, string> = {
  joy: 'happy',
  angry: 'angry',
  sorrow: 'sad',
  fun: 'relaxed',
  blink: 'blink',
  blink_l: 'blinkLeft',
  blink_r: 'blinkRight',
  a: 'aa',
  i: 'ih',
  u: 'ou',
  e: 'ee',
  o: 'oh',
  look_up: 'lookUp',
  look_down: 'lookDown',
  look_left: 'lookLeft',
  look_right: 'lookRight',
};
const V1_TO_V0: Record<string, string> = Object.fromEntries(
  Object.entries(V0_TO_V1).map(([v0, v1]) => [v1, v0]),
);

// VRM 0.x stores _Color/_EmissionColor in gamma space (three-vrm decodes with
// pow 2.2, see its gammaEOTF); encode back with the inverse.
const ENCODE_GAMMA = 1 / 2.2;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface ModelAssociations {
  materialIndexByName: Record<string, number>;
  meshNodeIndicesByName: Record<string, number[]>;
}

/** Export an edited model. `bytes` must be the original (unedited) file. */
export async function exportEditedModel(
  bytes: ArrayBuffer,
  edits: ModelEdits,
  associations?: ModelAssociations | null,
): Promise<ArrayBuffer> {
  const { json, bin } = parseGlb(bytes);
  const binBuf = await applyMaterialEdits(json, copyBin(bin), edits, associations);
  applyHiddenParts(json, edits.hiddenParts);
  applyHiddenMeshes(json, edits.hiddenMeshes, associations);
  applyExpressionEdits(json, edits.expressions);
  applyMetaEdits(json, edits.meta);
  applyBoneScaleEdits(json, edits.boneScale);
  return writeGlb(json, binBuf);
}

// --- Materials ---

function materialIndexFor(json: Record<string, any>, name: string): number {
  return (json.materials ?? []).findIndex((m: any) => m.name === name);
}

async function applyMaterialEdits(
  json: Record<string, any>,
  bin: Uint8Array,
  edits: ModelEdits,
  associations?: ModelAssociations | null,
): Promise<Uint8Array> {
  let out = bin;
  for (const [name, edit] of Object.entries(edits.materials)) {
    const idx = associations?.materialIndexByName?.[name] ?? materialIndexFor(json, name);
    if (idx == null || idx < 0) continue;
    const mat = json.materials[idx];

    applyCoreMaterialEdit(mat, edit);
    applyV0MaterialEdit(json, idx, edit);
    if (edit.textureFile) {
      const bytes = new Uint8Array(await edit.textureFile.arrayBuffer());
      out = applyTextureEdit(json, out, idx, bytes, mimeTypeFor(edit.textureFile.name));
    }
  }
  return out;
}

/** Core glTF material properties (used directly by VRM 1.0, kept in sync for 0.x). */
function applyCoreMaterialEdit(mat: any, e: MaterialEdit): void {
  const pbr = (mat.pbrMetallicRoughness ??= {});
  if (e.color) {
    pbr.baseColorFactor = [e.color[0], e.color[1], e.color[2], e.opacity ?? pbr.baseColorFactor?.[3] ?? 1];
  }
  if (e.opacity !== undefined) {
    const base = pbr.baseColorFactor ?? [1, 1, 1, 1];
    pbr.baseColorFactor = [base[0], base[1], base[2], e.opacity];
  }
  if (e.alphaMode) {
    mat.alphaMode = e.alphaMode;
    if (e.alphaMode === 'MASK') mat.alphaCutoff ??= 0.5;
    else delete mat.alphaCutoff;
  }
  if (e.emissive) mat.emissiveFactor = [...e.emissive];
  if (e.doubleSided !== undefined) mat.doubleSided = e.doubleSided;
}

/** Mirror edits into the VRM 0.x materialProperties (the source of truth for VRM 0.x loaders). */
function applyV0MaterialEdit(json: Record<string, any>, idx: number, e: MaterialEdit): void {
  const props = json.extensions?.VRM?.materialProperties?.[idx];
  if (!props) return;
  const vp = (props.vectorProperties ??= {});
  const fp = (props.floatProperties ??= {});
  const kw = (props.keywordMap ??= {});
  const gamma = (v: number) => Math.pow(clamp01(v), ENCODE_GAMMA);

  if (e.color || e.opacity !== undefined) {
    const cur: number[] = vp._Color ?? [1, 1, 1, 1];
    const rgb = e.color ? e.color : [cur[0], cur[1], cur[2]]; // existing values are already gamma
    vp._Color = [gamma(rgb[0]), gamma(rgb[1]), gamma(rgb[2]), e.opacity ?? cur[3] ?? 1];
  }
  if (e.emissive) vp._EmissionColor = [gamma(e.emissive[0]), gamma(e.emissive[1]), gamma(e.emissive[2]), 1];
  if (e.alphaMode) {
    kw._ALPHABLEND_ON = e.alphaMode === 'BLEND' ? 1 : 0;
    kw._ALPHATEST_ON = e.alphaMode === 'MASK' ? 1 : 0;
    if (e.alphaMode === 'MASK') fp._Cutoff ??= 0.5;
  }
  if (e.doubleSided !== undefined) fp._CullMode = e.doubleSided ? 0 : 2;
}

/** Swap the material's base texture: embed the new image in the BIN and rewire texture refs. */
function applyTextureEdit(
  json: Record<string, any>,
  bin: Uint8Array,
  idx: number,
  bytes: Uint8Array,
  mime: string,
): Uint8Array {
  const mat = json.materials[idx];
  const prevTexIndex =
    mat.pbrMetallicRoughness?.baseColorTexture?.index ??
    mat.extensions?.VRMC_materials_mtoon?.baseColorTexture?.index;
  const samplers = (json.samplers ??= []);
  let samplerIndex: number;
  if (prevTexIndex != null && json.textures?.[prevTexIndex]?.sampler != null) {
    samplerIndex = json.textures[prevTexIndex].sampler; // keep the original's wrap/filtering
  } else if (samplers.length > 0) {
    samplerIndex = 0;
  } else {
    samplers.push({ wrapS: 33071, wrapT: 33071 }); // CLAMP_TO_EDGE, like VRM textures
    samplerIndex = 0;
  }

  const { imageIndex, bin: newBin } = appendImage(json, bin, bytes, mime);

  const textureIndex = (json.textures ??= []).length;
  json.textures.push({ sampler: samplerIndex, source: imageIndex });

  ((mat.pbrMetallicRoughness ??= {}).baseColorTexture) = { index: textureIndex };
  const mtoon = mat.extensions?.VRMC_materials_mtoon;
  if (mtoon) mtoon.baseColorTexture = { index: textureIndex };
  const v0props = json.extensions?.VRM?.materialProperties?.[idx];
  if (v0props) (v0props.textureProperties ??= {})._MainTex = textureIndex;

  return newBin;
}

// --- Hidden asset parts (individual primitives of merged meshes) ---

/**
 * Remove hidden primitives from the glTF JSON. Removing the primitive (instead
 * of an invisible-material trick) leaves no draw call and no alpha-sorting
 * artifacts in any viewer; the freed accessors/materials stay in the file
 * (still valid glTF) so nothing else needs reindexing. A mesh whose every
 * primitive is hidden falls back to the whole-node hide (clearNode).
 */
function applyHiddenParts(json: Record<string, any>, hiddenParts: string[]): void {
  if (hiddenParts.length === 0) return;
  const hidden = new Map<number, Set<number>>();
  for (const id of hiddenParts) {
    const parsed = parsePartId(id);
    if (!parsed) continue;
    let set = hidden.get(parsed.mesh);
    if (!set) hidden.set(parsed.mesh, (set = new Set()));
    set.add(parsed.primitive);
  }

  const fullyHiddenMeshes = new Set<number>();
  for (const [meshIndex, primSet] of hidden) {
    const mesh = json.meshes?.[meshIndex];
    if (!mesh?.primitives) continue;
    if (primSet.size >= mesh.primitives.length) {
      // Every primitive hidden — can't leave a mesh with zero primitives;
      // clear the referencing nodes below instead.
      fullyHiddenMeshes.add(meshIndex);
      continue;
    }
    mesh.primitives = mesh.primitives.filter((_: any, pi: number) => !primSet.has(pi));
  }

  if (fullyHiddenMeshes.size > 0) {
    for (const node of json.nodes ?? []) {
      if (node.mesh != null && fullyHiddenMeshes.has(node.mesh)) {
        delete node.mesh;
        delete node.skin;
      }
    }
  }
}

// --- Hidden meshes ---

function applyHiddenMeshes(
  json: Record<string, any>,
  hidden: string[],
  associations?: ModelAssociations | null,
): void {
  if (hidden.length === 0) return;
  const hide = new Set(hidden);
  const clearNode = (node: any) => {
    delete node.mesh;
    delete node.skin;
  };
  // Preferred: exact node indices captured from the loader at load time.
  if (associations?.meshNodeIndicesByName) {
    const idxs = new Set<number>();
    for (const name of hidden) {
      for (const i of associations.meshNodeIndicesByName[name] ?? []) idxs.add(i);
    }
    if (idxs.size > 0) {
      for (const i of idxs) {
        const node = json.nodes?.[i];
        if (node && node.mesh != null) clearNode(node);
      }
      return;
    }
  }
  // Fallback: name matching (single-primitive meshes are named after their node).
  for (const node of json.nodes ?? []) {
    if (node.mesh != null && hide.has(node.name)) clearNode(node);
  }
  // Multi-primitive nodes show up under the glTF mesh's name (with a unique
  // suffix when duplicated); also hide whole meshes by name.
  const hiddenMeshIndices = new Set<number>();
  (json.meshes ?? []).forEach((m: any, i: number) => {
    if (!m.name) return;
    if (hide.has(m.name) || hide.has(m.name.replace(/\.\d+$/, ''))) hiddenMeshIndices.add(i);
  });
  if (hiddenMeshIndices.size > 0) {
    for (const node of json.nodes ?? []) {
      if (node.mesh != null && hiddenMeshIndices.has(node.mesh)) clearNode(node);
    }
  }
}

// --- Expressions (baked into morph target weights, so they survive in every viewer) ---

function applyExpressionEdits(json: Record<string, any>, expressions: Record<string, number>): void {
  const entries = Object.entries(expressions);
  if (entries.length === 0) return;
  const byName = new Map(entries);

  const vrm1 = json.extensions?.VRMC_vrm;
  if (vrm1?.expressions) {
    const all = { ...(vrm1.expressions.preset ?? {}), ...(vrm1.expressions.custom ?? {}) };
    for (const [name, weight] of byName) {
      const expr = all[name];
      for (const bind of expr?.morphTargetBinds ?? []) {
        bakeMorphWeight(json, bind.node, bind.index, weight * (bind.weight ?? 1));
      }
    }
    return;
  }

  const groups = json.extensions?.VRM?.blendShapeMaster?.blendShapeGroups ?? [];
  for (const group of groups) {
    const v1Name = V0_TO_V1[group.presetName] ?? group.name;
    const weight = v1Name != null ? byName.get(v1Name) : undefined;
    if (weight == null) continue;
    for (const bind of group.binds ?? []) {
      // VRM 0.x bind weights are 0..100
      bakeMorphWeight(json, undefined, bind.index, (weight * (bind.weight ?? 100)) / 100, bind.mesh);
    }
  }
}

/** Where a morph weight lives for the mesh used by `nodeIdx` (VRM 1.0) / `meshIdx` (VRM 0.x). */
function morphWeightTargets(
  json: Record<string, any>,
  nodeIdx: number | undefined,
  morphIndex: number,
  meshIdx?: number,
): { mesh: any; usingNodes: any[] } | null {
  let mi = meshIdx;
  if (mi == null && nodeIdx != null) mi = json.nodes?.[nodeIdx]?.mesh;
  if (mi == null) return null;
  const mesh = json.meshes?.[mi];
  const morphCount = mesh?.primitives?.[0]?.targets?.length;
  if (!morphCount || morphIndex >= morphCount) return null;
  const usingNodes = (json.nodes ?? []).filter((n: any) => n.mesh === mi && Array.isArray(n.weights));
  return { mesh, usingNodes };
}

/**
 * Write the expression's contribution into the file's default morph weights
 * (mesh.weights / node.weights). The value REPLACES whatever was there — the
 * file always stores exactly `expressionWeight × bindWeight`, so re-editing an
 * exported file stays consistent.
 */
function bakeMorphWeight(
  json: Record<string, any>,
  nodeIdx: number | undefined,
  morphIndex: number,
  value: number,
  meshIdx?: number,
): void {
  const targets = morphWeightTargets(json, nodeIdx, morphIndex, meshIdx);
  if (!targets) return;
  if (targets.usingNodes.length > 0) {
    for (const n of targets.usingNodes) n.weights[morphIndex] = clamp01(value);
  } else {
    const weights = (targets.mesh.weights ??= new Array(targets.mesh.primitives[0].targets.length).fill(0));
    weights[morphIndex] = clamp01(value);
  }
}

/**
 * Read the expression weights already baked into the file's rest pose, so the
 * editor can preview them (three-vrm zeroes rest morph influences on update).
 */
export function bakedExpressionsFromJson(json: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  const read = (nodeIdx: number | undefined, morphIndex: number, meshIdx?: number) => {
    const targets = morphWeightTargets(json, nodeIdx, morphIndex, meshIdx);
    if (!targets) return null;
    if (targets.usingNodes.length > 0) return targets.usingNodes[0].weights[morphIndex] ?? 0;
    return targets.mesh.weights?.[morphIndex] ?? 0;
  };

  const vrm1 = json.extensions?.VRMC_vrm;
  if (vrm1?.expressions) {
    const all = { ...(vrm1.expressions.preset ?? {}), ...(vrm1.expressions.custom ?? {}) };
    for (const [name, expr] of Object.entries<any>(all)) {
      for (const bind of expr?.morphTargetBinds ?? []) {
        const bw = bind.weight ?? 1;
        if (!bw) continue;
        const rest = read(bind.node, bind.index);
        if (rest == null) continue;
        const w = clamp01(rest / bw);
        if (w > 0.005) out[name] = w;
        break;
      }
    }
    return out;
  }

  const groups = json.extensions?.VRM?.blendShapeMaster?.blendShapeGroups ?? [];
  for (const group of groups) {
    const name = V0_TO_V1[group.presetName] ?? group.name;
    if (name == null) continue;
    for (const bind of group.binds ?? []) {
      const bw = (bind.weight ?? 100) / 100;
      if (!bw) continue;
      const rest = read(undefined, bind.index, bind.mesh);
      if (rest == null) continue;
      const w = clamp01(rest / bw);
      if (w > 0.005) out[name] = w;
      break;
    }
  }
  return out;
}

// --- Meta ---

const V1_META_FIELDS = ['name', 'version', 'author', 'contactInformation', 'licenseUrl', 'commercialUssageName'];
const V0_META_FIELDS = [
  'title',
  'version',
  'author',
  'contactInformation',
  'reference',
  'allowedUserName',
  'violentUssageName',
  'sexualUssageName',
  'commercialUssageName',
  'licenseName',
  'otherLicenseUrl',
];

export function metaFieldsFor(json: Record<string, any>): string[] {
  return json.extensions?.VRMC_vrm ? V1_META_FIELDS : V0_META_FIELDS;
}

function applyMetaEdits(json: Record<string, any>, meta: Record<string, string>): void {
  const ext = json.extensions?.VRMC_vrm ?? json.extensions?.VRM;
  if (!ext || Object.keys(meta).length === 0) return;
  const m = (ext.meta ??= {});
  const fields = metaFieldsFor(json);
  for (const [key, value] of Object.entries(meta)) {
    if (!fields.includes(key)) continue;
    if (value === '') delete m[key];
    else m[key] = value;
  }
}

// --- Bone scale (proportions) ---

/** Look up a humanoid bone's node index; VRM 1.0 uses a map, VRM 0.x an array of {bone, node}. */
function humanoidBoneNode(json: Record<string, any>, bone: string): number | undefined {
  const hb = json.extensions?.VRMC_vrm?.humanoid?.humanBones ?? json.extensions?.VRM?.humanoid?.humanBones;
  if (!hb) return undefined;
  if (Array.isArray(hb)) return hb.find((e: any) => e.bone === bone)?.node;
  return hb[bone]?.node;
}

// Bone behaviour (which bones thicken, which compensate children) is shared
// with the live preview via ./proportions, so the export always matches what
// the user saw: torso & limb bones thicken (scale only the two local axes
// perpendicular to the bone's length and divide their children's
// scale/translation on those axes, so the part thickens without stretching or
// displacing its neighbours); shoulders pivot the arm outward; head/hands/
// feet/hips scale the whole part.

/** Local axis (0=x, 1=y, 2=z) a bone node points along, judged from the first
 *  canonical child's rest translation; falls back to the largest-offset
 *  child, then Y. Matches live.ts boneLengthAxis. */
function gltfLengthAxis(json: Record<string, any>, bone: string, node: Record<string, any>): 0 | 1 | 2 {
  let probe: number[] | undefined;
  const children = node.children ?? [];
  for (const name of LENGTH_AXIS_CHILD[bone] ?? []) {
    const idx = humanoidBoneNode(json, name);
    if (idx != null && children.includes(idx)) {
      probe = json.nodes?.[idx]?.translation;
      if (probe) break;
    }
  }
  if (!probe) {
    let best = 0;
    for (const ci of children) {
      const t = json.nodes?.[ci]?.translation;
      if (!t) continue;
      const m = Math.max(Math.abs(t[0]), Math.abs(t[1]), Math.abs(t[2]));
      if (m > best) {
        best = m;
        probe = t;
      }
    }
  }
  if (!probe) return 1;
  const ax = Math.abs(probe[0]);
  const ay = Math.abs(probe[1]);
  const az = Math.abs(probe[2]);
  return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
}

/** Height (metres) of a node above the model root, summing translation[1] up
 *  the parent chain — valid because humanoid bones rest unrotated in VRM. */
function nodeHeightY(json: Record<string, any>, idx: number): number {
  const parent = new Map<number, number>();
  (json.nodes ?? []).forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parent.set(c, i)));
  let y = 0;
  for (let cur: number | undefined = idx; cur != null; cur = parent.get(cur)) {
    y += json.nodes?.[cur]?.translation?.[1] ?? 0;
  }
  return y;
}

/** Hips height above the lowest foot/toe node — the lift a whole-body hips
 *  scale needs so the model keeps standing on the floor. 0 when unknown. */
function hipsToFeetDistance(json: Record<string, any>, hipsIdx: number): number {
  const feet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']
    .map((b) => humanoidBoneNode(json, b))
    .filter((i): i is number => i != null);
  if (feet.length === 0) return 0;
  const hipsY = nodeHeightY(json, hipsIdx);
  return Math.max(0, hipsY - Math.min(...feet.map((i) => nodeHeightY(json, i))));
}

function applyBoneScaleEdits(json: Record<string, any>, boneScale: Record<string, number>): void {
  // Parents first (BONE_ORDER is depth-first), multiplying/dividing CURRENT
  // values — identical to the live preview, so adjacent segments compose the
  // same way and the export matches what the user saw.
  for (const bone of BONE_ORDER) {
    const factor = boneScale[bone];
    if (factor == null || Math.abs(factor - 1) < 0.005) continue;
    const nodeIdx = humanoidBoneNode(json, bone);
    const node = nodeIdx != null ? json.nodes?.[nodeIdx] : null;
    if (!node) continue;

    if (THICKEN_BONES.has(bone)) {
      const axis = gltfLengthAxis(json, bone, node);
      const fx = axis === 0 ? 1 : factor;
      const fy = axis === 1 ? 1 : factor;
      const fz = axis === 2 ? 1 : factor;
      const s = node.scale ?? [1, 1, 1];
      node.scale = [s[0] * fx, s[1] * fy, s[2] * fz];
      for (const ci of node.children ?? []) {
        const child = json.nodes?.[ci];
        if (!child) continue;
        const cs = child.scale ?? [1, 1, 1];
        child.scale = [cs[0] / fx, cs[1] / fy, cs[2] / fz];
        if (child.translation) {
          child.translation = [
            child.translation[0] / fx,
            child.translation[1] / fy,
            child.translation[2] / fz,
          ];
        }
      }
    } else {
      node.scale = (node.scale ?? [1, 1, 1]).map((v: number) => v * factor);
      if (COMPENSATE_CHILD_SCALE.has(bone)) {
        for (const ci of node.children ?? []) {
          const child = json.nodes?.[ci];
          if (!child) continue;
          const cs = child.scale ?? [1, 1, 1];
          child.scale = [cs[0] / factor, cs[1] / factor, cs[2] / factor];
        }
      } else if (bone === 'hips' && nodeIdx != null) {
        // Whole-body scale raises the legs off the ground by the leg-length
        // growth — translate the hips up by the same amount so the model keeps
        // standing on its feet (mirrors the live hips lift).
        const drop = hipsToFeetDistance(json, nodeIdx);
        if (drop > 0) {
          const t = node.translation ?? [0, 0, 0];
          node.translation = [t[0], t[1] + (factor - 1) * drop, t[2]];
        }
      }
    }
  }
}
