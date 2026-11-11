// AI tool executor: maps tool calls (from the in-app assistant or the MCP
// bridge) onto editor store actions and lib helpers. Every tool returns
// { ok: true, result } or { ok: false, error } — never throws.

import { Color, Euler, Quaternion } from 'three';
import { useEditor, HIPS_TRACK_ID } from '../../store';
import { captureHipsPosition, captureQuat, getNormNode } from '../animation';
import { allocKeyId, EASES, type Ease, type PosKey, type RotKey, type VrmaData } from '../vrma/parse';
import { buildVRMA } from '../vrma/build';
import { exportEditedModel } from '../vrmedit/exportModel';
import {
  applyAllBoneScales,
  applyExpressionWeight,
  applyMaterialEdit,
  boneHasNode,
  collectMaterials,
  expressionNames,
  resetMaterialLive,
  stripOutlineSuffix,
} from '../vrmedit/live';
import { applyAssetVisibilityAll, collectParts, collectWholeMeshes } from '../vrmedit/parts';
import { BONE_ORDER, BONE_PARENTS } from '../humanoid';
import { getViewport } from './sceneRef';

const DEG = Math.PI / 180;

export class ToolError extends Error {}

function requireVrm() {
  const { vrm } = useEditor.getState();
  if (!vrm) throw new ToolError('No model is loaded. Load a model first (load_model or the toolbar).');
  return vrm;
}

function requireBone(vrm: Parameters<typeof getNormNode>[0], bone: string) {
  const node = getNormNode(vrm, bone);
  if (!node) throw new ToolError(`Bone "${bone}" does not exist on this model. Call list_bones for valid names.`);
  return node;
}

function asEase(v: unknown): Ease | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'string' || !EASES.includes(v as Ease)) {
    throw new ToolError(`ease must be one of: ${EASES.join(', ')}`);
  }
  return v as Ease;
}

function num3(v: unknown, label: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new ToolError(`${label} must be an array of 3 finite numbers`);
  }
  return [v[0], v[1], v[2]];
}

function quat4(v: unknown): [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new ToolError('quaternion must be an array of 4 finite numbers [x, y, z, w]');
  }
  const q = new Quaternion(v[0], v[1], v[2], v[3]).normalize();
  return [q.x, q.y, q.z, q.w];
}

/** Hex like "#ff3366" → linear-space rgb triple (three.js working space). */
function hexToLinear(hex: string): [number, number, number] {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(hex.trim())) {
    throw new ToolError(`color must be a hex string like "#ff3366" (got ${JSON.stringify(hex)})`);
  }
  const c = new Color().setStyle(hex.trim());
  return [c.r, c.g, c.b];
}

/** Live euler degrees → canonical quaternion (the inverse of the pose sliders + captureQuat). */
function eulerDegToCanonical(eulerDeg: unknown, isVrm0: boolean): [number, number, number, number] {
  const [x, y, z] = num3(eulerDeg, 'euler');
  const q = new Quaternion().setFromEuler(new Euler(x * DEG, y * DEG, z * DEG, 'YXZ'));
  return isVrm0 ? [-q.x, q.y, -q.z, q.w] : [q.x, q.y, q.z, q.w];
}

function downloadBlob(data: ArrayBuffer, filename: string, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function safeName(base: string, ext: string): string {
  return `${base.replace(/[^\w\-]+/g, '_') || 'file'}.${ext}`;
}

function poseAt(time: number): { ok: true; t: number } {
  const st = useEditor.getState();
  st.setTime(time);
  return { ok: true, t: useEditor.getState().time };
}

// --- Tool implementations ---

async function toolGetState() {
  const st = useEditor.getState();
  const keyed: Record<string, number> = {};
  for (const [bone, keys] of Object.entries(st.rotTracks)) {
    if (keys?.length) keyed[bone] = keys.length;
  }
  return {
    model: {
      loaded: !!st.vrm,
      name: st.modelName,
      url: st.modelUrl,
      bones: st.vrm ? Object.keys(st.vrm.humanoid?.humanBones ?? {}).length : 0,
      restHipsY: st.restHipsPos.y,
      metaFields: st.modelMeta?.fields ?? null,
      metaValues: st.modelMeta ? { ...st.modelMeta.values, ...st.modelEdits.meta } : null,
    },
    animation: {
      name: st.animName,
      duration: st.duration,
      restHipsY: st.animRestHipsY,
      keyedBones: keyed,
      hipsKeys: st.hipsTrack.length,
      time: st.time,
    },
    transport: { playing: st.playing, loop: st.loop, autoKey: st.autoKey, snap: st.snap },
    edits: {
      materials: Object.keys(st.modelEdits.materials).length,
      hiddenMeshes: st.modelEdits.hiddenMeshes,
      hiddenParts: st.modelEdits.hiddenParts,
      expressions: st.modelEdits.expressions,
      meta: st.modelEdits.meta,
      boneScale: st.modelEdits.boneScale,
    },
  };
}

function toolListBones() {
  const vrm = requireVrm();
  const st = useEditor.getState();
  return BONE_ORDER.map((bone) => ({
    name: bone,
    parent: BONE_PARENTS[bone] ?? null,
    hasNode: getNormNode(vrm, bone) != null,
    keys: st.rotTracks[bone]?.length ?? 0,
  }));
}

function toolListMaterials() {
  const vrm = requireVrm();
  const edits = useEditor.getState().modelEdits.materials;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const m of collectMaterials(vrm)) {
    const base = stripOutlineSuffix(m.name);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ name: base, edit: edits[base] ?? null });
  }
  return { materials: out };
}

function toolListAssets() {
  const vrm = requireVrm();
  const st = useEditor.getState();
  return {
    meshes: collectWholeMeshes(vrm).map((m) => ({ ...m, hidden: st.modelEdits.hiddenMeshes.includes(m.id) })),
    parts: collectParts(vrm).map((p) => ({ ...p, hidden: st.modelEdits.hiddenParts.includes(p.id) })),
  };
}

function toolListExpressions() {
  const vrm = requireVrm();
  const st = useEditor.getState();
  const baked = st.modelBakedExpressions;
  return {
    expressions: expressionNames(vrm).map((name) => ({
      name,
      current: vrm.expressionManager?.getValue(name) ?? 0,
      baked: baked[name] ?? 0,
      edited: st.modelEdits.expressions[name] ?? null,
    })),
  };
}

async function toolListModels() {
  const st = useEditor.getState();
  await st.fetchModelLibrary();
  const fresh = useEditor.getState();
  return { models: fresh.modelLibrary.map((m) => m.name), current: fresh.modelUrl };
}

function toolListOutfits() {
  const st = useEditor.getState();
  return { outfits: st.outfitsFor().presets };
}

function toolGetAnimation(): VrmaData {
  return useEditor.getState().getAnimData();
}

function normalizeVrmaData(v: unknown): VrmaData {
  if (typeof v !== 'object' || v == null) throw new ToolError('animation must be an object');
  const a = v as Record<string, unknown>;
  const duration = a.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new ToolError('animation.duration must be a positive number (seconds)');
  }
  const rotTracks: Partial<Record<string, RotKey[]>> = {};
  const tracksIn = (a.rotTracks ?? {}) as Record<string, unknown>;
  for (const [bone, keys] of Object.entries(tracksIn)) {
    if (!Array.isArray(keys)) throw new ToolError(`rotTracks.${bone} must be an array of keys`);
    rotTracks[bone] = keys.map((k, i) => {
      const key = k as Partial<RotKey> & { t: number; q: number[] };
      if (typeof key.t !== 'number' || !Array.isArray(key.q)) {
        throw new ToolError(`rotTracks.${bone}[${i}] needs { t: number, q: [x,y,z,w] }`);
      }
      return {
        id: typeof key.id === 'number' ? key.id : allocKeyId(),
        t: key.t,
        q: quat4(key.q),
        ...(key.ease != null ? { ease: asEase(key.ease) } : {}),
      } as RotKey;
    });
  }
  const hipsTrack: PosKey[] = Array.isArray(a.hipsTrack)
    ? (a.hipsTrack as unknown[]).map((k, i) => {
        const key = k as Partial<PosKey> & { t: number; p: number[] };
        if (typeof key.t !== 'number' || !Array.isArray(key.p)) {
          throw new ToolError(`hipsTrack[${i}] needs { t: number, p: [x,y,z] }`);
        }
        return {
          id: typeof key.id === 'number' ? key.id : allocKeyId(),
          t: key.t,
          p: num3(key.p, `hipsTrack[${i}].p`),
          ...(key.ease != null ? { ease: asEase(key.ease) } : {}),
        } as PosKey;
      })
    : [];
  const restHipsY =
    typeof a.restHipsY === 'number' && Number.isFinite(a.restHipsY)
      ? a.restHipsY
      : useEditor.getState().restHipsPos.y || 1;
  return {
    name: typeof a.name === 'string' && a.name ? a.name : 'AI animation',
    duration,
    restHipsY,
    rotTracks,
    hipsTrack,
  };
}

function toolSetAnimation(args: { animation?: unknown }) {
  const data = normalizeVrmaData(args.animation);
  useEditor.getState().importAnim(data);
  return { applied: true, name: data.name, duration: data.duration };
}

function toolNewAnimation(args: { name?: unknown; duration?: unknown }) {
  const st = useEditor.getState();
  st.newAnim();
  if (typeof args.name === 'string' && args.name) st.setAnimName(args.name);
  if (typeof args.duration === 'number' && Number.isFinite(args.duration)) st.setDuration(Math.max(0.1, args.duration));
  const s = useEditor.getState();
  return { name: s.animName, duration: s.duration };
}

function toolAddRotationKey(args: {
  bone?: unknown;
  time?: unknown;
  euler?: unknown;
  quaternion?: unknown;
  ease?: unknown;
  capture?: unknown;
}) {
  if (typeof args.bone !== 'string' || !args.bone) throw new ToolError('bone is required');
  const vrm = requireVrm();
  requireBone(vrm, args.bone);
  if (args.capture) requireBone(vrm, args.bone);

  if (typeof args.time === 'number' && Number.isFinite(args.time)) poseAt(args.time);
  const st = useEditor.getState();
  const flip = vrm.meta?.metaVersion === '0';

  let q: [number, number, number, number];
  if (args.quaternion != null) q = quat4(args.quaternion);
  else if (args.euler != null) q = eulerDegToCanonical(args.euler, flip);
  else {
    const captured = captureQuat(vrm, args.bone);
    if (!captured) throw new ToolError(`Could not capture the current pose of "${args.bone}".`);
    q = captured;
  }

  st.upsertRotKey(args.bone, q);
  const s = useEditor.getState();
  const keys = s.rotTracks[args.bone] ?? [];
  const sel = s.selectedKey;
  if (args.ease != null && sel) st.setKeyEase(sel.track, sel.id, asEase(args.ease)!, undefined, { history: false });
  const t = keys.find((k) => sel && k.id === sel.id)?.t ?? s.time;
  return { keyed: args.bone, t, keys: keys.length };
}

function toolAddHipsKey(args: { time?: unknown; offset?: unknown; pos?: unknown; ease?: unknown }) {
  const vrm = requireVrm();
  if (typeof args.time === 'number' && Number.isFinite(args.time)) poseAt(args.time);
  const st = useEditor.getState();

  let p: [number, number, number];
  if (args.pos != null) p = num3(args.pos, 'pos');
  else if (args.offset != null) {
    const [dx, dy, dz] = num3(args.offset, 'offset');
    p = [dx, st.animRestHipsY + dy, dz];
  } else {
    const captured = captureHipsPosition(vrm, st.restHipsPos, st.animRestHipsY);
    if (!captured) throw new ToolError('Could not capture the current hips position.');
    p = captured;
  }

  st.upsertHipsKey(p);
  const s = useEditor.getState();
  const sel = s.selectedKey;
  if (args.ease != null && sel) st.setKeyEase(sel.track, sel.id, asEase(args.ease)!, undefined, { history: false });
  const t = s.hipsTrack.find((k) => sel && k.id === sel.id)?.t ?? s.time;
  return { keyed: HIPS_TRACK_ID, t, keys: s.hipsTrack.length };
}

function toolClearTrack(args: { track?: unknown }) {
  if (typeof args.track !== 'string' || !args.track) throw new ToolError('track is required');
  const st = useEditor.getState();
  const n =
    args.track === HIPS_TRACK_ID
      ? st.hipsTrack.length
      : st.rotTracks[args.track]?.length ?? 0;
  if (n === 0) return { cleared: 0, note: 'Track already empty' };
  if (args.track !== HIPS_TRACK_ID && !getNormNode(requireVrm(), args.track)) {
    throw new ToolError(`Unknown track "${args.track}".`);
  }
  st.deleteBoneKeys(args.track);
  return { cleared: n };
}

function findKey(track: string, keyId: unknown): { id: number; t: number } {
  if (typeof keyId !== 'number') throw new ToolError('keyId must be a number (see get_animation)');
  const st = useEditor.getState();
  const keys = track === HIPS_TRACK_ID ? st.hipsTrack : st.rotTracks[track] ?? [];
  const key = keys.find((k) => k.id === keyId);
  if (!key) throw new ToolError(`Key ${keyId} not found on track "${track}". Call get_animation for valid ids.`);
  return { id: key.id, t: key.t };
}

function toolMoveKey(args: { track?: unknown; keyId?: unknown; time?: unknown }) {
  if (typeof args.track !== 'string') throw new ToolError('track is required');
  findKey(args.track, args.keyId);
  if (typeof args.time !== 'number' || !Number.isFinite(args.time)) throw new ToolError('time must be a number (seconds)');
  useEditor.getState().moveKey(args.track, args.keyId as number, args.time);
  return { moved: true, track: args.track, keyId: args.keyId, t: useEditor.getState().snapTime(args.time) };
}

function toolSetKeyEase(args: { track?: unknown; keyId?: unknown; ease?: unknown; bez?: unknown }) {
  if (typeof args.track !== 'string') throw new ToolError('track is required');
  findKey(args.track, args.keyId);
  const ease = asEase(args.ease);
  if (!ease) throw new ToolError('ease is required');
  let bez: [number, number, number, number] | undefined;
  if (ease === 'custom') {
    if (!Array.isArray(args.bez) || args.bez.length !== 4 || args.bez.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new ToolError("custom ease needs bez: [x1, y1, x2, y2] (CSS cubic-bezier handles)");
    }
    bez = args.bez as [number, number, number, number];
  }
  useEditor.getState().setKeyEase(args.track, args.keyId as number, ease, bez);
  return { set: true, track: args.track, keyId: args.keyId, ease };
}

function toolSetTrackEase(args: { track?: unknown; ease?: unknown }) {
  if (typeof args.track !== 'string') throw new ToolError('track is required');
  const ease = asEase(args.ease);
  if (!ease) throw new ToolError('ease is required');
  useEditor.getState().setTrackEase(args.track, ease);
  return { set: true, track: args.track, ease };
}

function toolSetTransport(args: Record<string, unknown>) {
  const st = useEditor.getState();
  if (typeof args.duration === 'number' && Number.isFinite(args.duration)) st.setDuration(Math.max(0.1, args.duration));
  if (typeof args.time === 'number' && Number.isFinite(args.time)) st.setTime(args.time);
  if (typeof args.playing === 'boolean') st.setPlaying(args.playing);
  if (typeof args.loop === 'boolean') st.setLoop(args.loop);
  if (typeof args.autoKey === 'boolean') st.setAutoKey(args.autoKey);
  if (typeof args.snap === 'number' && Number.isFinite(args.snap)) st.setSnap(Math.max(0, args.snap));
  if (typeof args.name === 'string' && args.name) st.setAnimName(args.name);
  const s = useEditor.getState();
  return {
    name: s.animName,
    duration: s.duration,
    time: s.time,
    playing: s.playing,
    loop: s.loop,
    autoKey: s.autoKey,
    snap: s.snap,
  };
}

function toolResetPose() {
  const st = useEditor.getState();
  requireVrm();
  st.resetPose();
  return { reset: true };
}

function toolSetMaterial(args: Record<string, unknown>) {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw new ToolError('name is required (see list_materials)');
  const vrm = requireVrm();
  const patch: Record<string, unknown> = {};
  if (args.color != null) patch.color = hexToLinear(args.color as string);
  if (args.emissive != null) patch.emissive = hexToLinear(args.emissive as string);
  if (args.opacity != null) {
    if (typeof args.opacity !== 'number' || !Number.isFinite(args.opacity)) throw new ToolError('opacity must be a number');
    patch.opacity = Math.min(1, Math.max(0, args.opacity));
  }
  if (args.alphaMode != null) {
    if (args.alphaMode !== 'OPAQUE' && args.alphaMode !== 'MASK' && args.alphaMode !== 'BLEND') {
      throw new ToolError("alphaMode must be 'OPAQUE', 'MASK' or 'BLEND'");
    }
    patch.alphaMode = args.alphaMode;
  }
  if (args.doubleSided != null) {
    if (typeof args.doubleSided !== 'boolean') throw new ToolError('doubleSided must be a boolean');
    patch.doubleSided = args.doubleSided;
  }
  if (Object.keys(patch).length === 0) throw new ToolError('Nothing to change — pass color/emissive/opacity/alphaMode/doubleSided');
  const st = useEditor.getState();
  st.setMaterialEdit(name, patch as never);
  applyMaterialEdit(vrm, name, patch as never);
  return { edited: name, patch: { ...patch, color: args.color, emissive: args.emissive } };
}

function toolResetMaterial(args: { name?: unknown }) {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw new ToolError('name is required');
  const vrm = requireVrm();
  const st = useEditor.getState();
  if (!st.modelEdits.materials[name]) return { reset: name, note: 'No edit to reset' };
  st.resetMaterialEdit(name);
  resetMaterialLive(vrm, name);
  return { reset: name };
}

function toolSetVisibility(args: {
  hideMeshes?: unknown;
  showMeshes?: unknown;
  hideParts?: unknown;
  showParts?: unknown;
}) {
  const vrm = requireVrm();
  const st = useEditor.getState();
  const strList = (v: unknown, label: string): string[] => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ToolError(`${label} must be an array of ids (see list_assets)`);
    return v as string[];
  };
  for (const id of strList(args.hideMeshes, 'hideMeshes')) st.setMeshHidden(id, true);
  for (const id of strList(args.showMeshes, 'showMeshes')) st.setMeshHidden(id, false);
  for (const id of strList(args.hideParts, 'hideParts')) st.setPartHidden(id, true);
  for (const id of strList(args.showParts, 'showParts')) st.setPartHidden(id, false);
  const next = useEditor.getState().modelEdits;
  applyAssetVisibilityAll(vrm, next.hiddenMeshes, next.hiddenParts);
  return {
    hiddenMeshes: next.hiddenMeshes,
    hiddenParts: next.hiddenParts,
  };
}

function toolSetExpression(args: { name?: unknown; weight?: unknown }) {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw new ToolError('name is required (see list_expressions)');
  if (typeof args.weight !== 'number' || !Number.isFinite(args.weight)) throw new ToolError('weight must be a number 0..1');
  const weight = Math.min(1, Math.max(0, args.weight));
  const vrm = requireVrm();
  if (!expressionNames(vrm).includes(name)) {
    throw new ToolError(`Unknown expression "${name}". Call list_expressions.`);
  }
  const st = useEditor.getState();
  st.setExpressionEdit(name, weight);
  applyExpressionWeight(vrm, name, weight);
  return { name, weight };
}

function toolSetBoneScale(args: { bone?: unknown; factor?: unknown }) {
  const bone = typeof args.bone === 'string' ? args.bone : '';
  if (!bone) throw new ToolError('bone is required');
  if (typeof args.factor !== 'number' || !Number.isFinite(args.factor)) throw new ToolError('factor must be a number');
  const vrm = requireVrm();
  if (!boneHasNode(vrm, bone)) {
    throw new ToolError(`Unknown bone "${bone}" for proportions. Try: head, neck, spine, chest, upperChest, hips, shoulders, arms, hands, legs, feet.`);
  }
  const factor = Math.min(4, Math.max(0.25, args.factor));
  const st = useEditor.getState();
  st.setBoneScale(bone, factor);
  applyAllBoneScales(vrm, useEditor.getState().modelEdits.boneScale);
  return { bone, factor };
}

function toolSetMeta(args: { field?: unknown; value?: unknown }) {
  const field = typeof args.field === 'string' ? args.field : '';
  if (!field) throw new ToolError('field is required (see get_state metaFields)');
  if (typeof args.value !== 'string') throw new ToolError('value must be a string (empty string clears)');
  useEditor.getState().setMetaEdit(field, args.value);
  return { field, value: args.value };
}

function toolApplyOutfit(args: { name?: unknown }) {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw new ToolError('name is required (see list_outfits)');
  const vrm = requireVrm();
  const preset = useEditor.getState().applyOutfit(name);
  if (!preset) throw new ToolError(`No outfit named "${name}" for this model. Call list_outfits.`);
  applyAssetVisibilityAll(vrm, preset.hiddenMeshes, preset.hiddenParts);
  return { applied: name, hiddenMeshes: preset.hiddenMeshes, hiddenParts: preset.hiddenParts };
}

function toolSaveOutfit(args: { name?: unknown }) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) throw new ToolError('name is required');
  useEditor.getState().saveOutfit(name);
  return { saved: name };
}

async function toolLoadModel(args: { name?: unknown }) {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw new ToolError('name is required (see list_models)');
  const st = useEditor.getState();
  await st.fetchModelLibrary();
  const lib = useEditor.getState().modelLibrary;
  const entry = lib.find((m) => m.name === name) ?? lib.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (!entry) {
    throw new ToolError(`"${name}" is not in the model library. Available: ${lib.map((m) => m.name).join(', ') || '(none)'}`);
  }
  if (useEditor.getState().modelUrl !== entry.url) {
    useEditor.getState().openLibraryModel(entry.name);
  }
  // Wait for the Viewport load effect to finish (30s cap).
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const s = useEditor.getState();
    if (s.vrm && !s.modelLoading && s.modelName === entry.name) {
      return { loaded: entry.name, bones: Object.keys(s.vrm.humanoid?.humanBones ?? {}).length };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new ToolError(`Timed out loading "${name}" — check the viewport for errors.`);
}

function toolExportAnimation() {
  const st = useEditor.getState();
  const keyCount =
    Object.values(st.rotTracks).reduce((n, k) => n + (k?.length ?? 0), 0) + st.hipsTrack.length;
  if (keyCount === 0) throw new ToolError('Nothing to export — the animation has no keyframes.');
  const buffer = buildVRMA(st.getAnimData());
  const filename = safeName(st.animName || 'animation', 'vrma');
  downloadBlob(buffer, filename, 'application/octet-stream');
  return { exported: filename, bytes: buffer.byteLength, keys: keyCount };
}

async function toolSaveModel() {
  const st = useEditor.getState();
  if (!st.modelUrl || !st.vrm) throw new ToolError('No model is loaded.');
  const bytes = st.originalModelBytes ?? (await (await fetch(st.modelUrl)).arrayBuffer());
  const cur = useEditor.getState();
  const out = await exportEditedModel(bytes, cur.modelEdits, cur.modelAssociations);
  const filename = safeName(`${st.modelName.replace(/\.(vrm|glb|gltf)$/i, '')}-edited`, 'vrm');
  downloadBlob(out, filename, 'model/gltf-binary');
  return { saved: filename, bytes: out.byteLength, edits: Object.keys(cur.modelEdits).length };
}

function toolScreenshot() {
  const vp = getViewport();
  if (!vp) throw new ToolError('Viewport not ready yet.');
  // Render immediately before reading pixels — the drawing buffer is only
  // valid in the same task when preserveDrawingBuffer is off.
  vp.renderer.render(vp.scene, vp.camera);
  const canvas = vp.renderer.domElement;
  const dataUrl = canvas.toDataURL('image/png');
  return { dataUrl, width: canvas.width, height: canvas.height };
}

// --- Dispatcher ---

type ToolImpl = (args: Record<string, unknown>) => unknown | Promise<unknown>;

const IMPLS: Record<string, ToolImpl> = {
  get_state: () => toolGetState(),
  list_bones: () => toolListBones(),
  list_materials: () => toolListMaterials(),
  list_assets: () => toolListAssets(),
  list_expressions: () => toolListExpressions(),
  list_models: () => toolListModels(),
  list_outfits: () => toolListOutfits(),
  get_animation: () => toolGetAnimation(),
  set_animation: (a) => toolSetAnimation(a as never),
  new_animation: (a) => toolNewAnimation(a as never),
  add_rotation_key: (a) => toolAddRotationKey(a as never),
  add_hips_key: (a) => toolAddHipsKey(a as never),
  clear_track: (a) => toolClearTrack(a as never),
  move_key: (a) => toolMoveKey(a as never),
  set_key_ease: (a) => toolSetKeyEase(a as never),
  set_track_ease: (a) => toolSetTrackEase(a as never),
  set_transport: (a) => toolSetTransport(a),
  reset_pose: () => toolResetPose(),
  undo: () => useEditor.getState().undo(),
  redo: () => useEditor.getState().redo(),
  set_material: (a) => toolSetMaterial(a),
  reset_material: (a) => toolResetMaterial(a as never),
  set_visibility: (a) => toolSetVisibility(a as never),
  set_expression: (a) => toolSetExpression(a as never),
  set_bone_scale: (a) => toolSetBoneScale(a as never),
  set_meta: (a) => toolSetMeta(a as never),
  apply_outfit: (a) => toolApplyOutfit(a as never),
  save_outfit: (a) => toolSaveOutfit(a as never),
  load_model: (a) => toolLoadModel(a as never),
  export_animation: () => toolExportAnimation(),
  save_model: () => toolSaveModel(),
  screenshot: () => toolScreenshot(),
};

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Execute one tool call by name. Never throws. */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const impl = IMPLS[name];
  if (!impl) return { ok: false, error: `Unknown tool "${name}"` };
  try {
    const result = await impl(args ?? {});
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof ToolError ? err.message : `Tool failed: ${(err as Error)?.message ?? String(err)}`;
    console.warn(`[ai] tool ${name} failed:`, err);
    return { ok: false, error: msg };
  }
}
