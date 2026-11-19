// Wardrobe export baking: merge worn donor parts into the target's glTF JSON
// so "Save model" produces a single VRM containing the swapped look.
//
// Skinning math (shared with the live preview via remapSkin): a donor joint is
// mapped onto the target's humanoid node of the same bone name (non-humanoid
// donor bones collapse onto their nearest humanoid ancestor), and the inverse
// bind matrix is recomputed as
//
//   IBM_new = W_targetRest⁻¹ · R_rel · W_donorRest · IBM_donor
//
// where the W's are the FILE rest-pose world matrices (VRM rest = T-pose) and
// R_rel rotates between the two files' facing conventions (VRM 0.x files face
// the opposite way of VRM 1.0). At rest this reproduces exactly the pose the
// user saw in the preview; when the target animates, the outfit follows the
// target's joints with the donor's bind offsets. Proportion (bone-scale) edits
// are applied AFTER baking, so the outfit rides the scaled skeleton the same
// way it rides the live one.
//
// Donor springbones are NOT carried over: sub-bone chains collapse onto their
// humanoid ancestor, so exported donor hair hangs rigid (the live preview
// keeps its sway).

import { Matrix4, Quaternion, Vector3 } from 'three';
import { parsePartId } from '../vrmedit/parts';
import { mimeTypeFor, parseGlb } from '../vrmedit/glb';
import { getDonor } from './sources';
import type { WornRef } from './wear';

// --- shared skin remap (used by the live preview too) ---

export interface SkinJointInput {
  /** Humanoid bone name when the donor joint IS that humanoid bone (the live
   *  preview only remaps those; export maps every joint via ancestor walk). */
  humanoidName: string | null;
  /** Donor-side FILE rest-pose world matrix of the joint. */
  donorRest: Matrix4;
  /** The donor skin's original inverse bind matrix for this joint. */
  donorIBM: Matrix4;
}

export interface SkinRemapResult {
  /** Target humanoid bone name per joint (null = keep the donor-side joint). */
  target: (string | null)[];
  /** New inverse bind matrix per joint. */
  ibm: Matrix4[];
}

/**
 * Compute the remapped inverse binds for a donor skin. IBM_new =
 * W_targetRest⁻¹ · R_rel · W_donorRest · IBM_donor — see the file comment.
 */
export function remapSkin(
  joints: SkinJointInput[],
  targetRestByName: Map<string, Matrix4>,
  relR: Matrix4,
): SkinRemapResult {
  const target: (string | null)[] = [];
  const ibm: Matrix4[] = [];
  const m = new Matrix4();
  for (const j of joints) {
    const tRest = j.humanoidName ? targetRestByName.get(j.humanoidName) : undefined;
    if (j.humanoidName && tRest) {
      // ibm = targetRest⁻¹ · relR · donorRest · donorIBM
      m.copy(tRest).invert().multiply(relR).multiply(j.donorRest).multiply(j.donorIBM);
      ibm.push(new Matrix4().copy(m));
      target.push(j.humanoidName);
    } else {
      ibm.push(new Matrix4().copy(j.donorIBM));
      target.push(null);
    }
  }
  return { target, ibm };
}

/** Facing convention rotation a loaded VRM applies at runtime (VRM 0.x faces
 *  the opposite way of VRM 1.0). Also the matrix between two files' spaces. */
export function conventionRotation(metaVersion: string | undefined): Matrix4 {
  if (metaVersion === '0') {
    return new Matrix4().makeRotationY(Math.PI);
  }
  return new Matrix4();
}

/** Relative rotation taking donor file space into target file space. */
export function relativeRotation(targetVersion: string | undefined, donorVersion: string | undefined): Matrix4 {
  // relR = C_target⁻¹ · C_donor
  return conventionRotation(targetVersion).invert().multiply(conventionRotation(donorVersion));
}

// --- node hierarchy math over glTF JSON ---

/** glTF node's LOCAL matrix (matrix property, or composed TRS). */
function nodeLocalMatrix(node: Record<string, any>): Matrix4 {
  if (node.matrix) return new Matrix4().fromArray(node.matrix as number[]);
  const q = new Quaternion();
  if (node.rotation) q.set(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
  const s = new Vector3(...(node.scale ?? [1, 1, 1]));
  const t = new Vector3(...(node.translation ?? [0, 0, 0]));
  return new Matrix4().compose(t, q, s);
}

/** Rest-pose world matrix of every node, memoized per json object. */
const restWorldCache = new WeakMap<Record<string, any>, Map<number, Matrix4>>();

export function nodeRestWorlds(json: Record<string, any>): Map<number, Matrix4> {
  let memo = restWorldCache.get(json);
  if (memo) return memo;
  memo = new Map();

  const parentOf = new Map<number, number>();
  (json.nodes ?? []).forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parentOf.set(c, i)));

  const world = (idx: number): Matrix4 => {
    const hit = memo!.get(idx);
    if (hit) return hit;
    const local = nodeLocalMatrix(json.nodes?.[idx] ?? {});
    const parent = parentOf.get(idx);
    const m = parent != null ? new Matrix4().multiplyMatrices(world(parent), local) : local;
    memo!.set(idx, m);
    return m;
  };
  for (let i = 0; i < (json.nodes?.length ?? 0); i++) world(i);

  restWorldCache.set(json, memo);
  return memo;
}

/** Humanoid bone name → glTF node index, for VRM 1.0 and 0.x files. */
function humanoidNodeMap(json: Record<string, any>): Map<string, number> {
  const hb = json.extensions?.VRMC_vrm?.humanoid?.humanBones ?? json.extensions?.VRM?.humanoid?.humanBones;
  const out = new Map<string, number>();
  if (!hb) return out;
  if (Array.isArray(hb)) {
    for (const e of hb) if (e?.bone && e?.node != null) out.set(e.bone, e.node);
  } else {
    for (const [bone, e] of Object.entries<any>(hb)) if (e?.node != null) out.set(bone, e.node);
  }
  return out;
}

function metaVersionOf(json: Record<string, any>): string | undefined {
  return json.extensions?.VRMC_vrm ? '1' : json.extensions?.VRM ? '0' : undefined;
}

// --- accessor / bufferView plumbing ---

/** Append raw bytes to the BIN chunk as a new bufferView (4-byte aligned). */
function appendBytes(json: Record<string, any>, bin: Uint8Array, bytes: Uint8Array): { index: number; bin: Uint8Array } {
  const pad = (4 - (bin.length % 4)) % 4;
  const grown = new Uint8Array(bin.length + pad + bytes.length);
  grown.set(bin, 0);
  grown.set(bytes, bin.length + pad);
  const index = (json.bufferViews ??= []).length;
  json.bufferViews.push({ buffer: 0, byteOffset: bin.length + pad, byteLength: bytes.length });
  json.buffers[0].byteLength = grown.length;
  return { index, bin: grown };
}

function donorBufferViewBytes(djson: Record<string, any>, dbin: Uint8Array, bvIndex: number): Uint8Array | null {
  const bv = djson.bufferViews?.[bvIndex];
  if (!bv || bv.buffer !== 0 || !dbin) return null;
  const start = bv.byteOffset ?? 0;
  return dbin.subarray(start, start + (bv.byteLength ?? 0));
}

/** Read a MAT4 FLOAT accessor (stride-aware) as a flat 16-per-item array. */
function readMat4Accessor(json: Record<string, any>, bin: Uint8Array, accIndex: number): Float32Array | null {
  const acc = json.accessors?.[accIndex];
  if (!acc || acc.type !== 'MAT4' || acc.componentType !== 5126) return null;
  const bv = json.bufferViews?.[acc.bufferView];
  const bytes = bv ? donorBufferViewBytes(json, bin, acc.bufferView) : null;
  if (!bytes) return null;
  const count = acc.count;
  const out = new Float32Array(count * 16);
  const stride = bv.byteStride ?? 64;
  const base = (acc.byteOffset ?? 0);
  if (stride === 64) {
    out.set(new Float32Array(bytes.buffer, bytes.byteOffset + base, count * 16));
  } else {
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    for (let i = 0; i < count; i++) {
      for (let e = 0; e < 16; e++) out[i * 16 + e] = view[(base >> 2) + i * (stride >> 2) + e];
    }
  }
  return out;
}

// --- merge context ---

interface MergeCtx {
  json: Record<string, any>;
  bin: Uint8Array;
  djson: Record<string, any>;
  dbin: Uint8Array | null;
  donorName: string;
  donorVersion: string | undefined;
  // donor index → target index maps
  bv: Map<number, number>;
  acc: Map<number, number>;
  img: Map<number, number>;
  tex: Map<number, number>;
  samp: Map<number, number>;
  mat: Map<number, number>;
}

function copyBufferView(ctx: MergeCtx, donorIndex: number): number | null {
  const hit = ctx.bv.get(donorIndex);
  if (hit != null) return hit;
  const bytes = donorBufferViewBytes(ctx.djson, ctx.dbin!, donorIndex);
  if (!bytes) return null;
  const { index, bin } = appendBytes(ctx.json, ctx.bin, bytes.slice());
  const donorBv = ctx.djson.bufferViews[donorIndex];
  if (donorBv.byteStride != null) ctx.json.bufferViews[index].byteStride = donorBv.byteStride;
  ctx.bin = bin;
  ctx.bv.set(donorIndex, index);
  return index;
}

function copyAccessor(ctx: MergeCtx, donorIndex: number): number | null {
  const hit = ctx.acc.get(donorIndex);
  if (hit != null) return hit;
  const src = ctx.djson.accessors?.[donorIndex];
  if (!src) return null;
  const out: Record<string, any> = { ...src };
  if (src.bufferView != null) {
    const bv = copyBufferView(ctx, src.bufferView);
    if (bv == null) return null;
    out.bufferView = bv;
  }
  if (src.sparse) {
    out.sparse = { ...src.sparse };
    if (src.sparse.indices?.bufferView != null) {
      const bv = copyBufferView(ctx, src.sparse.indices.bufferView);
      if (bv == null) return null;
      out.sparse.indices = { ...src.sparse.indices, bufferView: bv };
    }
    if (src.sparse.values?.bufferView != null) {
      const bv = copyBufferView(ctx, src.sparse.values.bufferView);
      if (bv == null) return null;
      out.sparse.values = { ...src.sparse.values, bufferView: bv };
    }
  }
  const index = (ctx.json.accessors ??= []).length;
  ctx.json.accessors.push(out);
  ctx.acc.set(donorIndex, index);
  return index;
}

function copyImage(ctx: MergeCtx, donorIndex: number): number | null {
  const hit = ctx.img.get(donorIndex);
  if (hit != null) return hit;
  const src = ctx.djson.images?.[donorIndex];
  if (!src) return null;
  const mime = src.mimeType ?? mimeTypeFor(String(src.name ?? ''));
  let out: Record<string, any> | null = null;
  if (src.bufferView != null) {
    const bv = copyBufferView(ctx, src.bufferView);
    if (bv != null) out = { bufferView: bv, mimeType: mime };
  } else if (typeof src.uri === 'string' && src.uri.startsWith('data:')) {
    const b64 = src.uri.slice(src.uri.indexOf(',') + 1);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { index, bin } = appendBytes(ctx.json, ctx.bin, bytes);
    ctx.bin = bin;
    out = { bufferView: index, mimeType: mime };
  }
  if (!out) return null;
  const index = (ctx.json.images ??= []).length;
  ctx.json.images.push(out);
  ctx.img.set(donorIndex, index);
  return index;
}

function copySampler(ctx: MergeCtx, donorIndex: number): number | null {
  const hit = ctx.samp.get(donorIndex);
  if (hit != null) return hit;
  const src = ctx.djson.samplers?.[donorIndex] ?? {};
  const index = (ctx.json.samplers ??= []).length;
  ctx.json.samplers.push({ ...src });
  ctx.samp.set(donorIndex, index);
  return index;
}

function copyTexture(ctx: MergeCtx, donorIndex: number): number | null {
  const hit = ctx.tex.get(donorIndex);
  if (hit != null) return hit;
  const src = ctx.djson.textures?.[donorIndex];
  if (!src) return null;
  const out: Record<string, any> = { ...src };
  if (src.sampler != null) {
    const s = copySampler(ctx, src.sampler);
    if (s == null) return null;
    out.sampler = s;
  }
  if (src.source != null) {
    const i = copyImage(ctx, src.source);
    if (i == null) return null;
    out.source = i;
  }
  const index = (ctx.json.textures ??= []).length;
  ctx.json.textures.push(out);
  ctx.tex.set(donorIndex, index);
  return index;
}

/** glTF fields that hold texture references ({index}) on a material. */
const MATERIAL_TEXTURE_FIELDS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
] as const;
const MTOON_TEXTURE_FIELDS = [
  'baseColorTexture',
  'shadeMultiplyTexture',
  'normalTexture',
  'emissiveTexture',
  'matcapTexture',
  'rimTexture',
  'outlineWidthMultiplyTexture',
  'outlineColorTexture',
  'uvAnimationMaskTexture',
] as const;

function remapTextureRefs(ctx: MergeCtx, obj: Record<string, any>, fields: readonly string[]): boolean {
  let ok = true;
  for (const f of fields) {
    const ref = obj?.[f];
    if (!ref?.index) continue;
    const t = copyTexture(ctx, ref.index);
    if (t == null) {
      ok = false;
      delete obj[f];
      continue;
    }
    obj[f] = { ...ref, index: t };
  }
  return ok;
}

function copyMaterial(ctx: MergeCtx, donorIndex: number): number | null {
  const hit = ctx.mat.get(donorIndex);
  if (hit != null) return hit;
  const src = ctx.djson.materials?.[donorIndex];
  if (!src) return null;
  const out: Record<string, any> = JSON.parse(JSON.stringify(src));
  out.name = `${ctx.donorName}/${out.name ?? 'mat'}`;
  if (out.pbrMetallicRoughness) remapTextureRefs(ctx, out.pbrMetallicRoughness, MATERIAL_TEXTURE_FIELDS);
  remapTextureRefs(ctx, out, MATERIAL_TEXTURE_FIELDS);
  if (out.extensions?.VRMC_materials_mtoon) remapTextureRefs(ctx, out.extensions.VRMC_materials_mtoon, MTOON_TEXTURE_FIELDS);
  // Drop texture extensions we don't remap (basisu/KHR) rather than ship a
  // dangling index.
  if (out.extensions?.KHR_texture_basisu) delete out.extensions.KHR_texture_basisu;

  const index = (ctx.json.materials ??= []).length;
  ctx.json.materials.push(out);
  ctx.mat.set(donorIndex, index);

  // VRM 0.x targets index materialProperties by material index — append the
  // donor's entry so the arrays stay aligned. A VRM 1.0 donor has no
  // materialProperties; its MToon settings degrade to the copied PBR fields.
  const targetProps = ctx.json.extensions?.VRM?.materialProperties;
  if (targetProps) {
    const dprops = ctx.djson.extensions?.VRM?.materialProperties?.[donorIndex];
    const copy = dprops ? JSON.parse(JSON.stringify(dprops)) : { name: out.name, shader: 'VRM/UnlitTransparent' };
    if (copy.textureProperties) {
      for (const [k, t] of Object.entries<any>(copy.textureProperties)) {
        const mapped = copyTexture(ctx, t);
        if (mapped != null) copy.textureProperties[k] = mapped;
      }
    }
    targetProps[index] = copy;
  }
  return index;
}

// --- entry point ---

/** Group of worn ids for one donor mesh: which primitives to carry over. */
interface DonorMeshPick {
  mesh: number;
  primitives: Set<number>;
  /** true when the id was a whole-mesh name (take every primitive). */
  whole: boolean;
}

/**
 * Merge every worn donor part into the target json. Donors whose original
 * bytes are not loaded (session gone) are skipped. `bin` is replaced with the
 * grown buffer; the json gains the donor meshes, skins, materials and nodes.
 */
export function bakeWornParts(json: Record<string, any>, bin: Uint8Array, worn: WornRef[]): Uint8Array {
  if (worn.length === 0) return bin;

  // Group worn ids by donor.
  const byDonor = new Map<string, string[]>();
  for (const w of worn) {
    let list = byDonor.get(w.donor);
    if (!list) byDonor.set(w.donor, (list = []));
    list.push(w.id);
  }

  for (const [donorName, ids] of byDonor) {
    const donor = getDonor(donorName);
    if (!donor) {
      console.warn(`[wardrobe] donor "${donorName}" not loaded — its worn parts are not in the export`);
      continue;
    }
    try {
      const { json: djson, bin: dbin } = parseGlb(donor.bytes);
      bin = mergeDonor(json, bin, djson, dbin, donorName, ids);
    } catch (err) {
      console.warn(`[wardrobe] failed to bake donor "${donorName}"`, err);
    }
  }
  return bin;
}

function resolveDonorMeshPicks(djson: Record<string, any>, ids: string[]): DonorMeshPick[] {
  const picks = new Map<number, DonorMeshPick>();
  const add = (mesh: number, prim: number | null, whole: boolean) => {
    let p = picks.get(mesh);
    if (!p) picks.set(mesh, (p = { mesh, primitives: new Set(), whole: false }));
    if (whole) p.whole = true;
    else if (prim != null) p.primitives.add(prim);
  };
  for (const id of ids) {
    const parsed = parsePartId(id);
    if (parsed) {
      // Primitive id — must exist in the donor (meshes can change between sessions).
      if (djson.meshes?.[parsed.mesh]?.primitives?.[parsed.primitive]) add(parsed.mesh, parsed.primitive, false);
      continue;
    }
    // Whole-mesh id: find the donor node with this (loader) name and take all
    // its primitives. GLTFLoader keeps glTF node names, so match directly.
    const node = (djson.nodes ?? []).find((n: any) => n.name === id && n.mesh != null);
    if (node) add(node.mesh, null, true);
  }
  return [...picks.values()];
}

function mergeDonor(
  json: Record<string, any>,
  bin: Uint8Array,
  djson: Record<string, any>,
  dbin: Uint8Array | null,
  donorName: string,
  ids: string[],
): Uint8Array {
  const picks = resolveDonorMeshPicks(djson, ids);
  if (picks.length === 0) return bin;

  const donorWorlds = nodeRestWorlds(djson);
  const targetWorlds = nodeRestWorlds(json);
  const targetBones = humanoidNodeMap(json);
  const donorBones = humanoidNodeMap(djson);

  // donor node → parent node (for the humanoid-ancestor walk)
  const parentOf = new Map<number, number>();
  (djson.nodes ?? []).forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parentOf.set(c, i)));
  const donorNodeBone = new Map<number, string>();
  for (const [bone, node] of donorBones) donorNodeBone.set(node, bone);
  const ancestorBone = (node: number): string | null => {
    for (let cur: number | undefined = node; cur != null; cur = parentOf.get(cur)) {
      const bone = donorNodeBone.get(cur);
      if (bone) return bone;
    }
    return null;
  };

  const relR = relativeRotation(metaVersionOf(json), metaVersionOf(djson));
  const targetHips = targetBones.get('hips');

  const ctx: MergeCtx = {
    json,
    bin,
    djson,
    dbin,
    donorName,
    donorVersion: metaVersionOf(djson),
    bv: new Map(),
    acc: new Map(),
    img: new Map(),
    tex: new Map(),
    samp: new Map(),
    mat: new Map(),
  };

  for (const pick of picks) {
    // The donor node carrying this mesh (skinned if it has a skin).
    const dnode = (djson.nodes ?? []).find((n: any) => n.mesh === pick.mesh && n.skin != null)
      ?? (djson.nodes ?? []).find((n: any) => n.mesh === pick.mesh);
    if (!dnode) continue;
    const dmesh = djson.meshes[pick.mesh];
    const skinned = dnode.skin != null && djson.skins?.[dnode.skin] != null;

    // --- primitives (subset) ---
    const donorPrims: any[] = dmesh.primitives ?? [];
    const primIdxs = pick.whole ? donorPrims.map((_, i) => i) : [...pick.primitives].filter((i) => donorPrims[i]);
    if (primIdxs.length === 0) continue;
    const primitives = primIdxs.map((pi) => {
      const src = donorPrims[pi];
      const out: Record<string, any> = { ...src };
      out.attributes = {};
      for (const [attr, acc] of Object.entries<any>(src.attributes ?? {})) {
        const mapped = copyAccessor(ctx, acc);
        if (mapped != null) out.attributes[attr] = mapped;
      }
      if (src.indices != null) {
        const mapped = copyAccessor(ctx, src.indices);
        if (mapped != null) out.indices = mapped;
      }
      if (src.material != null) out.material = copyMaterial(ctx, src.material);
      if (src.targets) {
        out.targets = src.targets.map((t: Record<string, any>) => {
          const to: Record<string, any> = {};
          for (const [attr, acc] of Object.entries<any>(t)) {
            const mapped = copyAccessor(ctx, acc);
            if (mapped != null) to[attr] = mapped;
          }
          return to;
        });
      }
      delete out.extensions; // draco/mesh-compression cannot survive re-indexing
      delete out.extras;
      return out;
    });
    const meshIndex = (json.meshes ??= []).length;
    json.meshes.push({
      name: `${donorName}/${dmesh.name ?? 'mesh'}`,
      primitives,
      ...(dmesh.weights ? { weights: [...dmesh.weights] } : {}),
    });

    // --- node + skin ---
    const nodeIndex = (json.nodes ??= []).length;
    const node: Record<string, any> = { name: `${donorName}/${dnode.name ?? 'node'}` };
    if (skinned) {
      const dskin = djson.skins[dnode.skin];
      const joints: number[] = dskin.joints ?? [];
      const ibmSrc = dskin.inverseBindMatrices != null ? readMat4Accessor(djson, dbin!, dskin.inverseBindMatrices) : null;

      const jointInputs = joints.map((jn: number, i: number) => ({
        humanoidName: ancestorBone(jn),
        donorRest: donorWorlds.get(jn) ?? new Matrix4(),
        // IBM rows are indexed by JOINT index, not by the joint's node index.
        donorIBM: ibmSrc
          ? new Matrix4().fromArray(ibmSrc, i * 16)
          : new Matrix4().copy(donorWorlds.get(jn) ?? new Matrix4()).invert(),
      }));
      const remap = remapSkin(
        jointInputs,
        new Map([...targetBones].map(([bone, node]) => [bone, targetWorlds.get(node) ?? new Matrix4()])),
        relR,
      );

      const mappedJoints = remap.target.map((bone) => (bone != null ? targetBones.get(bone) : undefined));
      if (mappedJoints.every((n) => n != null)) {
        // Write the new inverse binds as a fresh MAT4 accessor.
        const arr = new Float32Array(joints.length * 16);
        remap.ibm.forEach((m, i) => arr.set(m.toArray(), i * 16));
        const { index: bvIndex, bin: grown } = appendBytes(
          json,
          ctx.bin,
          new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
        );
        ctx.bin = grown;
        const ibmAccessor = (json.accessors ??= []).length;
        json.accessors.push({ bufferView: bvIndex, componentType: 5126, count: joints.length, type: 'MAT4' });
        const skinIndex = (json.skins ??= []).length;
        json.skins.push({
          joints: mappedJoints as number[],
          inverseBindMatrices: ibmAccessor,
          ...(targetHips != null ? { skeleton: targetHips } : {}),
        });
        node.mesh = meshIndex;
        node.skin = skinIndex;
        // glTF ignores skinned-mesh node transforms; identity is the safe rest.
      } else {
        console.warn(`[wardrobe] donor mesh "${dmesh.name}" has joints outside the target humanoid — skipped`);
        continue;
      }
    } else {
      // Static mesh: carry the donor node's own transform.
      node.mesh = meshIndex;
      if (dnode.matrix) node.matrix = [...dnode.matrix];
      else {
        if (dnode.translation) node.translation = [...dnode.translation];
        if (dnode.rotation) node.rotation = [...dnode.rotation];
        if (dnode.scale) node.scale = [...dnode.scale];
      }
    }
    json.nodes.push(node);
    (json.scenes ??= [{ nodes: [] }])[0]?.nodes?.push(nodeIndex);
  }
  return ctx.bin;
}
