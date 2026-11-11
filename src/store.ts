import { create } from 'zustand';
import type { VRM } from '@pixiv/three-vrm';
import { Vector3 } from 'three';

// --- UI layout (persisted) ---
const UI_KEY = 'vrma-editor-ui';
const MODEL_KEY = 'vrma-editor-model';
interface UILayout {
  leftOpen: boolean;
  rightOpen: boolean;
  timelineH: number;
  leftW: number;
  rightW: number;
}
const DEFAULT_UI: UILayout = { leftOpen: true, rightOpen: true, timelineH: 218, leftW: 220, rightW: 270 };

// --- Model library / model edits ---
export interface LibraryModel {
  name: string;
  url: string;
}

export interface LibraryTexture {
  name: string;
  url: string;
}

/** List a library folder: dev middleware (/api/…) when available, manifest.json fallback. */
async function listLibrary(endpoint: string, manifestUrl: string): Promise<{ name: string; url: string }[]> {
  try {
    const res = await fetch(endpoint);
    if (res.ok) {
      const data = await res.json();
      const files: string[] = data.files ?? data.models ?? [];
      return files.map((name) => ({ name, url: `${manifestUrl}/${name}` }));
    }
  } catch {
    // not in dev mode — fall through to manifest
  }
  try {
    const res = await fetch(manifestUrl);
    if (res.ok) {
      const data = await res.json();
      const entries: { name: string }[] = Array.isArray(data) ? data : (data.files ?? []);
      return entries.map((e) => ({ name: e.name, url: `${manifestUrl}/${e.name}` }));
    }
  } catch {
    // no library available
  }
  return [];
}

export interface MaterialEdit {
  /** Linear-space rgb, 0..1 (matches three.js working space / glTF factors). */
  color?: [number, number, number];
  opacity?: number;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  emissive?: [number, number, number];
  doubleSided?: boolean;
  /** The texture file the user replaced the base texture with (kept for export). */
  textureFile?: File;
  /** Display name of that file. */
  textureName?: string;
}

export interface ModelEdits {
  materials: Record<string, MaterialEdit>;
  hiddenMeshes: string[];
  /** Ids of hidden asset parts ("glTF mesh index:primitive index"). */
  hiddenParts: string[];
  /** Expression name (VRM 1.0 naming) → default weight 0..1, baked into the model on export. */
  expressions: Record<string, number>;
  meta: Record<string, string>;
  /** Humanoid bone name → uniform scale factor. */
  boneScale: Record<string, number>;
}

const EMPTY_EDITS: ModelEdits = {
  materials: {},
  hiddenMeshes: [],
  hiddenParts: [],
  expressions: {},
  meta: {},
  boneScale: {},
};

export function countModelEdits(edits: ModelEdits): number {
  return (
    Object.keys(edits.materials).length +
    edits.hiddenMeshes.length +
    edits.hiddenParts.length +
    Object.keys(edits.expressions).length +
    Object.keys(edits.meta).length +
    Object.keys(edits.boneScale).length
  );
}

// --- Outfit presets (persisted per model, see the Assets panel) ---

export interface OutfitPreset {
  name: string;
  hiddenMeshes: string[];
  hiddenParts: string[];
}

const OUTFITS_KEY = 'vrma-editor-outfits';

type OutfitStore = Record<string, { presets: OutfitPreset[]; last?: string }>;

function loadOutfits(): OutfitStore {
  try {
    const raw = localStorage.getItem(OUTFITS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as OutfitStore;
    }
  } catch {
    // ignore corrupted storage
  }
  return {};
}

function saveOutfits(outfits: OutfitStore) {
  try {
    localStorage.setItem(OUTFITS_KEY, JSON.stringify(outfits));
  } catch {
    // ignore quota errors
  }
}

/** Persisted last model (never a blob: URL — those die with the session). */
function loadLastModel(): { url: string; name: string } | null {
  try {
    const raw = localStorage.getItem(MODEL_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (typeof v.url === 'string' && typeof v.name === 'string' && !v.url.startsWith('blob:')) {
        return { url: v.url, name: v.name };
      }
    }
  } catch {
    // ignore corrupted storage
  }
  return null;
}
function saveLastModel(url: string, name: string) {
  try {
    if (!url.startsWith('blob:')) localStorage.setItem(MODEL_KEY, JSON.stringify({ url, name }));
  } catch {
    // ignore quota errors
  }
}
function clampTimelineH(h: number): number {
  const max = Math.max(window.innerHeight - 240, 220);
  return Math.min(Math.max(Math.round(h), 110), max);
}
function clampLeftW(w: number): number {
  const max = Math.min(window.innerWidth - 420, 420);
  return Math.min(Math.max(Math.round(w), 180), Math.max(max, 180));
}
function clampRightW(w: number): number {
  const max = Math.min(window.innerWidth - 420, 480);
  return Math.min(Math.max(Math.round(w), 200), Math.max(max, 200));
}
function loadUI(): UILayout {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      return {
        leftOpen: v.leftOpen !== false,
        rightOpen: v.rightOpen !== false,
        timelineH: typeof v.timelineH === 'number' ? clampTimelineH(v.timelineH) : DEFAULT_UI.timelineH,
        leftW: typeof v.leftW === 'number' ? clampLeftW(v.leftW) : DEFAULT_UI.leftW,
        rightW: typeof v.rightW === 'number' ? clampRightW(v.rightW) : DEFAULT_UI.rightW,
      };
    }
  } catch {
    // ignore corrupted storage
  }
  return { ...DEFAULT_UI };
}
function saveUI(ui: UILayout) {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    // ignore quota errors
  }
}
import type { Ease, PosKey, Quat, RotKey, VrmaData, Vec3 } from './lib/vrma/parse';
import { allocKeyId } from './lib/vrma/parse';
import { captureHipsPosition, captureQuat, clearManipulated, manipulatedBones, resetToRestPose } from './lib/animation';
import { BONE_ORDER, BONE_ORDER_INDEX } from './lib/humanoid';

export interface Snapshot {
  animName: string;
  duration: number;
  rotTracks: Partial<Record<string, RotKey[]>>;
  hipsTrack: PosKey[];
  animRestHipsY: number;
}

export type TrackId = string; // bone name, or HIPS_TRACK_ID for hips translation
export const HIPS_TRACK_ID = '__hips__';

export interface Status {
  kind: 'info' | 'ok' | 'error';
  msg: string;
  seq: number;
}

interface EditorState {
  // model
  vrm: VRM | null;
  restHipsPos: Vector3;
  modelUrl: string | null;
  modelName: string;
  modelLoading: boolean;

  // model library + editing
  modelLibrary: LibraryModel[];
  textureLibrary: LibraryTexture[];
  originalModelBytes: ArrayBuffer | null;
  modelEdits: ModelEdits;
  /** Saved outfit presets, keyed by model name (see the Assets panel). */
  outfits: OutfitStore;
  /** Meta fields (original file's schema) + current values, captured at load. */
  modelMeta: { fields: string[]; values: Record<string, string> } | null;
  /** Exact glTF indices captured at load (parser.associations) — export uses
   *  these instead of matching by (sanitized) three.js names. */
  modelAssociations: {
    materialIndexByName: Record<string, number>;
    meshNodeIndicesByName: Record<string, number[]>;
  } | null;
  /** Expression weights already baked into the loaded file's rest pose. */
  modelBakedExpressions: Record<string, number>;
  rightTab: 'pose' | 'model';

  // animation
  animName: string;
  duration: number;
  rotTracks: Partial<Record<string, RotKey[]>>;
  hipsTrack: PosKey[];
  /** Rest hips height (Y) of the rig the animation was authored on. */
  animRestHipsY: number;

  // transport / editing
  time: number;
  playing: boolean;
  loop: boolean;
  autoKey: boolean;
  showSkeleton: boolean;
  snap: number; // seconds; 0 = off (default 1/30)
  selectedBone: string | null;
  /** Multi-selection for bulk key operations. selectedBone is the primary
   *  (gizmo target) and is always part of it when set. */
  selectedBones: string[];
  selectedKey: { track: TrackId; id: number } | null;
  poseTick: number; // bumped to re-render pose-bound UI while dragging

  // misc
  status: Status | null;
  past: Snapshot[];
  future: Snapshot[];

  // ui layout
  leftOpen: boolean;
  rightOpen: boolean;
  timelineH: number;
  leftW: number;
  rightW: number;
  setLeftOpen: (v: boolean) => void;
  setRightOpen: (v: boolean) => void;
  setTimelineH: (h: number) => void;
  setLeftW: (w: number) => void;
  setRightW: (w: number) => void;

  // actions
  setVrm: (vrm: VRM | null, restHips: Vector3, name: string) => void;
  setModelUrl: (url: string | null, name: string) => void;
  setModelLoading: (v: boolean) => void;
  fetchModelLibrary: () => Promise<void>;
  fetchTextureLibrary: () => Promise<void>;
  openLibraryModel: (name: string) => void;
  setOriginalModelBytes: (bytes: ArrayBuffer | null) => void;
  setModelMeta: (meta: { fields: string[]; values: Record<string, string> } | null) => void;
  setModelAssociations: (
    a: { materialIndexByName: Record<string, number>; meshNodeIndicesByName: Record<string, number[]> } | null,
  ) => void;
  setModelBakedExpressions: (baked: Record<string, number>) => void;
  clearModelEdits: () => void;
  setRightTab: (tab: 'pose' | 'model') => void;
  setMaterialEdit: (matName: string, patch: MaterialEdit) => void;
  resetMaterialEdit: (matName: string) => void;
  setMeshHidden: (meshName: string, hidden: boolean) => void;
  setPartHidden: (partId: string, hidden: boolean) => void;
  /** Saved outfits for the current model. */
  outfitsFor: () => { presets: OutfitPreset[]; last?: string };
  /** Snapshot the current visibility into a named outfit for this model. */
  saveOutfit: (name: string) => void;
  /** Apply a saved outfit to the visibility edits. Returns the preset (the caller applies it live). */
  applyOutfit: (name: string) => OutfitPreset | null;
  deleteOutfit: (name: string) => void;
  setExpressionEdit: (name: string, weight: number) => void;
  resetExpressionEdit: (name: string) => void;
  resetAllExpressionEdits: () => void;
  setMetaEdit: (field: string, value: string) => void;
  setBoneScale: (bone: string, factor: number) => void;
  setStatus: (kind: Status['kind'], msg: string) => void;
  bumpPose: () => void;

  setTime: (t: number) => void;
  setPlaying: (v: boolean) => void;
  togglePlay: () => void;
  setLoop: (v: boolean) => void;
  setAutoKey: (v: boolean) => void;
  setShowSkeleton: (v: boolean) => void;
  setSnap: (v: number) => void;
  setDuration: (d: number) => void;
  setAnimName: (n: string) => void;

  selectBone: (bone: string | null) => void;
  toggleBoneSelection: (bone: string) => void;
  selectBoneRange: (bone: string) => void;
  selectKey: (track: TrackId, id: number | null) => void;

  beginPoseStroke: () => void;
  manipulateBone: (bone: string, kind?: 'rot' | 'hipsPos' | 'both') => void;
  resetPose: () => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  snapTime: (t: number) => number;
  keySelectedBone: () => void;
  keyAllBones: () => void;
  upsertRotKey: (bone: string, q: Quat, opts?: { history?: boolean }) => void;
  upsertHipsKey: (p: Vec3, opts?: { history?: boolean }) => void;
  deleteSelectedKey: () => void;
  deleteBoneKeys: (bone: string) => void;
  deleteSelectedBonesKeys: () => void;
  moveKey: (track: TrackId, id: number, t: number) => void;
  setKeyEase: (track: TrackId, id: number, ease: Ease) => void;
  setTrackEase: (track: TrackId, ease: Ease) => void;

  getAnimData: () => VrmaData;
  importAnim: (data: VrmaData) => void;
  newAnim: () => void;
}

const clone = <T,>(v: T): T => structuredClone(v);

const DEFAULT_DURATION = 5;

let statusSeq = 0;

export const useEditor = create<EditorState>()((set, get) => ({
  vrm: null,
  restHipsPos: new Vector3(),
  modelUrl: loadLastModel()?.url ?? '/models/demo.glb',
  modelName: loadLastModel()?.name ?? 'demo.glb',
  modelLoading: true,

  modelLibrary: [],
  textureLibrary: [],
  originalModelBytes: null,
  modelEdits: clone(EMPTY_EDITS),
  outfits: loadOutfits(),
  modelMeta: null,
  modelAssociations: null,
  modelBakedExpressions: {},
  rightTab: 'pose',

  animName: 'New animation',
  duration: DEFAULT_DURATION,
  rotTracks: {},
  hipsTrack: [],
  animRestHipsY: 1,

  time: 0,
  playing: false,
  loop: true,
  autoKey: false,
  showSkeleton: true,
  snap: 1 / 30,
  selectedBone: null,
  selectedBones: [],
  selectedKey: null,
  poseTick: 0,

  status: null,
  past: [],
  future: [],

  ...loadUI(),
  setLeftOpen: (v) =>
    set((st) => {
      const ui = { leftOpen: v, rightOpen: st.rightOpen, timelineH: st.timelineH, leftW: st.leftW, rightW: st.rightW };
      saveUI(ui);
      return ui;
    }),
  setRightOpen: (v) =>
    set((st) => {
      const ui = { leftOpen: st.leftOpen, rightOpen: v, timelineH: st.timelineH, leftW: st.leftW, rightW: st.rightW };
      saveUI(ui);
      return ui;
    }),
  setTimelineH: (h) =>
    set((st) => {
      const ui = {
        leftOpen: st.leftOpen,
        rightOpen: st.rightOpen,
        timelineH: clampTimelineH(h),
        leftW: st.leftW,
        rightW: st.rightW,
      };
      saveUI(ui);
      return ui;
    }),
  setLeftW: (w) =>
    set((st) => {
      const ui = {
        leftOpen: st.leftOpen,
        rightOpen: st.rightOpen,
        timelineH: st.timelineH,
        leftW: clampLeftW(w),
        rightW: st.rightW,
      };
      saveUI(ui);
      return ui;
    }),
  setRightW: (w) =>
    set((st) => {
      const ui = {
        leftOpen: st.leftOpen,
        rightOpen: st.rightOpen,
        timelineH: st.timelineH,
        leftW: st.leftW,
        rightW: clampRightW(w),
      };
      saveUI(ui);
      return ui;
    }),

  setVrm: (vrm, restHips, name) =>
    set((st) => {
      // A fresh authoring session uses the model's own rest height; an
      // already-loaded animation keeps the rest height it was authored with.
      const isEmpty =
        Object.values(st.rotTracks).every((k) => (k?.length ?? 0) === 0) && st.hipsTrack.length === 0;
      return {
        vrm,
        restHipsPos: restHips,
        modelName: name,
        modelLoading: false,
        ...(isEmpty ? { animRestHipsY: restHips.y || 1 } : {}),
      };
    }),
  setModelUrl: (url, name) => {
    if (url) saveLastModel(url, name);
    set({
      modelUrl: url,
      modelName: name,
      modelLoading: true,
      vrm: null,
      // A different model invalidates all live edits and the cached original.
      modelEdits: clone(EMPTY_EDITS),
      originalModelBytes: null,
      modelMeta: null,
      modelAssociations: null,
      modelBakedExpressions: {},
      rightTab: 'pose',
    });
  },
  setModelLoading: (v) => set({ modelLoading: v }),

  // Library listings: dev server middleware (/api/…) when available,
  // manifest.json fallback for static builds.
  fetchModelLibrary: async () => {
    set({ modelLibrary: await listLibrary('/api/models', '/models') });
  },

  fetchTextureLibrary: async () => {
    set({ textureLibrary: await listLibrary('/api/textures', '/textures') });
  },

  openLibraryModel: (name) => {
    get().setModelUrl(`/models/${name}`, name);
  },

  setOriginalModelBytes: (bytes) => set({ originalModelBytes: bytes }),

  setModelMeta: (meta) => set({ modelMeta: meta }),

  setModelAssociations: (a) => set({ modelAssociations: a }),

  setModelBakedExpressions: (baked) => set({ modelBakedExpressions: baked }),

  clearModelEdits: () => set({ modelEdits: clone(EMPTY_EDITS) }),

  setRightTab: (tab) => set({ rightTab: tab }),

  setMaterialEdit: (matName, patch) =>
    set((s) => ({
      modelEdits: {
        ...s.modelEdits,
        materials: {
          ...s.modelEdits.materials,
          [matName]: { ...s.modelEdits.materials[matName], ...patch },
        },
      },
    })),
  resetMaterialEdit: (matName) =>
    set((s) => {
      const materials = { ...s.modelEdits.materials };
      delete materials[matName];
      return { modelEdits: { ...s.modelEdits, materials } };
    }),

  setMeshHidden: (meshName, hidden) =>
    set((s) => {
      const list = hidden
        ? s.modelEdits.hiddenMeshes.includes(meshName)
          ? s.modelEdits.hiddenMeshes
          : [...s.modelEdits.hiddenMeshes, meshName]
        : s.modelEdits.hiddenMeshes.filter((n) => n !== meshName);
      return { modelEdits: { ...s.modelEdits, hiddenMeshes: list } };
    }),

  setPartHidden: (partId, hidden) =>
    set((s) => {
      const list = hidden
        ? s.modelEdits.hiddenParts.includes(partId)
          ? s.modelEdits.hiddenParts
          : [...s.modelEdits.hiddenParts, partId]
        : s.modelEdits.hiddenParts.filter((p) => p !== partId);
      return { modelEdits: { ...s.modelEdits, hiddenParts: list } };
    }),

  // --- Outfits (visibility snapshots per model) ---

  outfitsFor: () => get().outfits[get().modelName] ?? { presets: [] },

  saveOutfit: (name) => {
    const { modelName, modelEdits } = get();
    const trimmed = name.trim();
    if (!trimmed) return;
    const preset: OutfitPreset = {
      name: trimmed,
      hiddenMeshes: [...modelEdits.hiddenMeshes],
      hiddenParts: [...modelEdits.hiddenParts],
    };
    set((s) => {
      const forModel = s.outfits[modelName] ?? { presets: [] };
      const presets = forModel.presets.some((p) => p.name === trimmed)
        ? forModel.presets.map((p) => (p.name === trimmed ? preset : p))
        : [...forModel.presets, preset];
      const outfits = { ...s.outfits, [modelName]: { presets, last: trimmed } };
      saveOutfits(outfits);
      return { outfits };
    });
  },

  applyOutfit: (name) => {
    const { modelName } = get();
    const preset = get().outfitsFor().presets.find((p) => p.name === name);
    if (!preset) return null;
    set((s) => ({
      modelEdits: {
        ...s.modelEdits,
        hiddenMeshes: [...preset.hiddenMeshes],
        hiddenParts: [...preset.hiddenParts],
      },
    }));
    const outfits = { ...get().outfits, [modelName]: { ...get().outfits[modelName]!, last: name } };
    saveOutfits(outfits);
    set({ outfits });
    return preset;
  },

  deleteOutfit: (name) => {
    const { modelName } = get();
    set((s) => {
      const forModel = s.outfits[modelName];
      if (!forModel) return s;
      const presets = forModel.presets.filter((p) => p.name !== name);
      const last = forModel.last === name ? undefined : forModel.last;
      const outfits = { ...s.outfits, [modelName]: { presets, last } };
      saveOutfits(outfits);
      return { outfits };
    });
  },

  setExpressionEdit: (name, weight) =>
    set((s) => ({
      // Always record — a 0 must be able to override a weight baked into the file.
      modelEdits: { ...s.modelEdits, expressions: { ...s.modelEdits.expressions, [name]: weight } },
    })),
  resetExpressionEdit: (name) =>
    set((s) => {
      const expressions = { ...s.modelEdits.expressions };
      delete expressions[name];
      return { modelEdits: { ...s.modelEdits, expressions } };
    }),
  resetAllExpressionEdits: () => set((s) => ({ modelEdits: { ...s.modelEdits, expressions: {} } })),

  setMetaEdit: (field, value) =>
    set((s) => {
      const meta = { ...s.modelEdits.meta };
      if (value === '') delete meta[field];
      else meta[field] = value;
      return { modelEdits: { ...s.modelEdits, meta } };
    }),

  setBoneScale: (bone, factor) =>
    set((s) => {
      const boneScale = { ...s.modelEdits.boneScale };
      if (Math.abs(factor - 1) < 0.005) delete boneScale[bone];
      else boneScale[bone] = factor;
      return { modelEdits: { ...s.modelEdits, boneScale } };
    }),

  setStatus: (kind, msg) => set({ status: { kind, msg, seq: ++statusSeq } }),
  bumpPose: () => set((s) => ({ poseTick: s.poseTick + 1 })),

  setTime: (t) => {
    const { duration } = get();
    const c = Math.min(Math.max(t, 0), duration);
    if (Math.abs(c - get().time) < 1e-9) return;
    clearManipulated();
    set({ time: c });
  },
  setPlaying: (v) => {
    if (!v) clearManipulated();
    set({ playing: v });
  },
  togglePlay: () => {
    const { playing, setPlaying } = get();
    setPlaying(!playing);
  },
  setLoop: (v) => set({ loop: v }),
  setAutoKey: (v) => set({ autoKey: v }),
  setShowSkeleton: (v) => set({ showSkeleton: v }),
  setSnap: (v) => set({ snap: v }),
  setDuration: (d) => {
    const duration = Math.max(0.1, d);
    set((s) => ({ duration, time: Math.min(s.time, duration) }));
  },
  setAnimName: (n) => set({ animName: n }),

  selectBone: (bone) =>
    set({ selectedBone: bone, selectedBones: bone ? [bone] : [] }),

  // Ctrl/Cmd+click: add/remove a bone from the multi-selection. The clicked
  // bone becomes the primary (gizmo target) when it joins the selection.
  toggleBoneSelection: (bone) =>
    set((s) => {
      if (s.selectedBones.includes(bone)) {
        const next = s.selectedBones.filter((b) => b !== bone);
        return {
          selectedBones: next,
          selectedBone: s.selectedBone === bone ? (next[next.length - 1] ?? null) : s.selectedBone,
        };
      }
      return { selectedBones: [...s.selectedBones, bone], selectedBone: bone };
    }),

  // Shift+click: select every bone between the current primary and `bone`
  // in canonical bone order (matches the bone tree's depth-first order).
  selectBoneRange: (bone) =>
    set((s) => {
      if (!s.selectedBone || s.selectedBone === bone) {
        return { selectedBone: bone, selectedBones: [bone] };
      }
      const a = BONE_ORDER_INDEX[s.selectedBone] ?? 0;
      const b = BONE_ORDER_INDEX[bone] ?? 0;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return { selectedBones: BONE_ORDER.slice(lo, hi + 1), selectedBone: bone };
    }),
  selectKey: (track, id) =>
    set({ selectedKey: id == null ? null : { track, id } }),

  // Called at the start of a manipulation stroke (gizmo drag, slider drag):
  // snapshots history once so the whole stroke is a single undo step.
  beginPoseStroke: () => {
    if (get().autoKey) get().pushHistory();
  },

  // Live edit of a normalized bone from the UI (gizmo, sliders). Marks the
  // bone as manually manipulated (playback sampler skips it) and, with
  // auto-key on, records it — converting live rig space to canonical space.
  manipulateBone: (bone, kind) => {
    const st = get();
    if (!st.vrm) return;
    manipulatedBones.add(bone);
    if (st.autoKey) {
      if (kind === 'rot' || kind === 'both') {
        const q = captureQuat(st.vrm, bone);
        if (q) st.upsertRotKey(bone, q, { history: false });
      }
      if ((kind === 'hipsPos' || kind === 'both') && bone === 'hips') {
        const p = captureHipsPosition(st.vrm, st.restHipsPos, st.animRestHipsY);
        if (p) st.upsertHipsKey(p, { history: false });
      }
    }
    st.bumpPose();
  },

  resetPose: () => {
    const { vrm, restHipsPos } = get();
    if (!vrm) return;
    resetToRestPose(vrm, restHipsPos);
    get().bumpPose();
  },

  pushHistory: () =>
    set((s) => ({
      past: [...s.past.slice(-99), {
        animName: s.animName,
        duration: s.duration,
        rotTracks: clone(s.rotTracks),
        hipsTrack: clone(s.hipsTrack),
        animRestHipsY: s.animRestHipsY,
      }],
      future: [],
    })),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      clearManipulated();
      return {
        past: s.past.slice(0, -1),
        future: [...s.future, {
          animName: s.animName,
          duration: s.duration,
          rotTracks: clone(s.rotTracks),
          hipsTrack: clone(s.hipsTrack),
          animRestHipsY: s.animRestHipsY,
        }],
        animName: prev.animName,
        duration: prev.duration,
        rotTracks: prev.rotTracks,
        hipsTrack: prev.hipsTrack,
        animRestHipsY: prev.animRestHipsY,
        time: Math.min(s.time, prev.duration),
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[s.future.length - 1];
      if (!next) return s;
      clearManipulated();
      return {
        future: s.future.slice(0, -1),
        past: [...s.past, {
          animName: s.animName,
          duration: s.duration,
          rotTracks: clone(s.rotTracks),
          hipsTrack: clone(s.hipsTrack),
          animRestHipsY: s.animRestHipsY,
        }],
        animName: next.animName,
        duration: next.duration,
        rotTracks: next.rotTracks,
        hipsTrack: next.hipsTrack,
        animRestHipsY: next.animRestHipsY,
        time: Math.min(s.time, next.duration),
      };
    }),

  snapTime: (t) => {
    const { snap, duration } = get();
    const v = snap > 0 ? Math.round(t / snap) * snap : t;
    return Math.min(Math.max(v, 0), duration);
  },

  keySelectedBone: () => {
    const { vrm, selectedBone, restHipsPos } = get();
    if (!vrm || !selectedBone) {
      get().setStatus('info', 'Select a bone first');
      return;
    }
    if (selectedBone === 'hips') {
      const q = captureQuat(vrm, 'hips');
      const p = captureHipsPosition(vrm, restHipsPos, get().animRestHipsY);
      if (q) get().upsertRotKey('hips', q);
      if (p) get().upsertHipsKey(p, { history: false });
    } else {
      const q = captureQuat(vrm, selectedBone);
      if (!q) return;
      get().upsertRotKey(selectedBone, q);
    }
  },

  keyAllBones: () => {
    const { vrm, restHipsPos } = get();
    if (!vrm) return;
    get().pushHistory();
    clearManipulated();
    for (const bone of Object.keys(vrm.humanoid.humanBones)) {
      const q = captureQuat(vrm, bone);
      if (q) get().upsertRotKey(bone, q, { history: false });
    }
    const p = captureHipsPosition(vrm, restHipsPos, get().animRestHipsY);
    if (p) get().upsertHipsKey(p, { history: false });
    get().setStatus('ok', 'Keyed full pose');
  },

  upsertRotKey: (bone, q, opts) => {
    const { history = true } = opts ?? {};
    const t = get().snapTime(get().time);
    if (history) get().pushHistory();
    set((s) => {
      const keys = [...(s.rotTracks[bone] ?? [])];
      const existing = keys.findIndex((k) => Math.abs(k.t - t) < 1e-6);
      let id: number;
      if (existing >= 0) {
        keys[existing] = { ...keys[existing], q };
        id = keys[existing].id;
      } else {
        id = allocKeyId();
        keys.push({ id, t, q });
        keys.sort((a, b) => a.t - b.t);
      }
      return {
        rotTracks: { ...s.rotTracks, [bone]: keys },
        selectedKey: { track: bone, id },
      };
    });
  },

  upsertHipsKey: (p, opts) => {
    const { history = true } = opts ?? {};
    const t = get().snapTime(get().time);
    if (history) get().pushHistory();
    set((s) => {
      const keys = [...s.hipsTrack];
      const existing = keys.findIndex((k) => Math.abs(k.t - t) < 1e-6);
      let id: number;
      if (existing >= 0) {
        keys[existing] = { ...keys[existing], p };
        id = keys[existing].id;
      } else {
        id = allocKeyId();
        keys.push({ id, t, p });
        keys.sort((a, b) => a.t - b.t);
      }
      return {
        hipsTrack: keys,
        selectedKey: { track: HIPS_TRACK_ID, id },
      };
    });
  },

  deleteSelectedKey: () => {
    const sel = get().selectedKey;
    if (!sel) return;
    get().pushHistory();
    set((s) => {
      if (sel.track === HIPS_TRACK_ID) {
        return { hipsTrack: s.hipsTrack.filter((k) => k.id !== sel.id), selectedKey: null };
      }
      const keys = s.rotTracks[sel.track];
      if (!keys) return s;
      return {
        rotTracks: { ...s.rotTracks, [sel.track]: keys.filter((k) => k.id !== sel.id) },
        selectedKey: null,
      };
    });
  },

  deleteBoneKeys: (bone) => {
    const s = get();
    if (bone === HIPS_TRACK_ID) {
      if (s.hipsTrack.length === 0) return;
      s.pushHistory();
      set({ hipsTrack: [], selectedKey: null });
      return;
    }
    if ((s.rotTracks[bone]?.length ?? 0) === 0) return;
    s.pushHistory();
    set((st) => ({
      rotTracks: { ...st.rotTracks, [bone]: [] },
      selectedKey: st.selectedKey?.track === bone ? null : st.selectedKey,
    }));
  },

  // Remove the entire animation (all keyframes) of every selected bone.
  // For hips this also clears the hips-position track. One undo step.
  deleteSelectedBonesKeys: () => {
    const s = get();
    if (s.selectedBones.length === 0) {
      s.setStatus('info', 'Select bones first — Ctrl/Cmd+click to multi-select');
      return;
    }
    const rotBones = s.selectedBones.filter((b) => (s.rotTracks[b]?.length ?? 0) > 0);
    const clearHips = s.selectedBones.includes('hips') && s.hipsTrack.length > 0;
    const removedKeys =
      rotBones.reduce((n, b) => n + s.rotTracks[b]!.length, 0) + (clearHips ? s.hipsTrack.length : 0);
    if (removedKeys === 0) {
      s.setStatus('info', 'Selected bones have no keyframes');
      return;
    }
    s.pushHistory();
    set((st) => {
      const rotTracks = { ...st.rotTracks };
      for (const b of rotBones) rotTracks[b] = [];
      // Un-stick manually posed bones so cleared ones fall back to rest pose.
      for (const b of s.selectedBones) manipulatedBones.delete(b);
      const sel = st.selectedKey;
      const keyDeleted =
        !!sel && (rotBones.includes(sel.track) || (sel.track === HIPS_TRACK_ID && clearHips));
      return {
        rotTracks,
        ...(clearHips ? { hipsTrack: [] } : {}),
        ...(keyDeleted ? { selectedKey: null } : {}),
      };
    });
    get().bumpPose();
    const nBones = rotBones.length + (clearHips ? 1 : 0);
    get().setStatus(
      'ok',
      `Removed ${removedKeys} keyframe${removedKeys === 1 ? '' : 's'} from ${nBones} bone${nBones === 1 ? '' : 's'}`,
    );
  },

  moveKey: (track, id, t) => {
    const nt = get().snapTime(t);
    set((s) => {
      const update = <K extends { id: number; t: number }>(keys: K[]): K[] | null => {
        const idx = keys.findIndex((k) => k.id === id);
        if (idx < 0) return null;
        const next = [...keys];
        next[idx] = { ...next[idx], t: nt };
        next.sort((a, b) => a.t - b.t);
        return next;
      };
      if (track === HIPS_TRACK_ID) {
        const next = update(s.hipsTrack);
        return next ? { hipsTrack: next } : s;
      }
      const keys = s.rotTracks[track];
      if (!keys) return s;
      const next = update(keys);
      return next ? { rotTracks: { ...s.rotTracks, [track]: next } } : s;
    });
  },

  setKeyEase: (track, id, ease) => {
    get().pushHistory();
    set((s) => {
      if (track === HIPS_TRACK_ID) {
        return {
          hipsTrack: s.hipsTrack.map((k) => (k.id === id ? { ...k, ease } : k)),
        };
      }
      const keys = s.rotTracks[track];
      if (!keys) return s;
      return {
        rotTracks: {
          ...s.rotTracks,
          [track]: keys.map((k) => (k.id === id ? { ...k, ease } : k)),
        },
      };
    });
  },

  setTrackEase: (track, ease) => {
    get().pushHistory();
    set((s) => {
      if (track === HIPS_TRACK_ID) {
        return { hipsTrack: s.hipsTrack.map((k) => ({ ...k, ease })) };
      }
      const keys = s.rotTracks[track];
      if (!keys) return s;
      return {
        rotTracks: { ...s.rotTracks, [track]: keys.map((k) => ({ ...k, ease })) },
      };
    });
  },

  getAnimData: () => {
    const s = get();
    return {
      name: s.animName,
      duration: s.duration,
      rotTracks: s.rotTracks,
      hipsTrack: s.hipsTrack,
      restHipsY: s.animRestHipsY,
    };
  },

  importAnim: (data) => {
    get().pushHistory();
    clearManipulated();
    set({
      animName: data.name,
      duration: data.duration,
      rotTracks: data.rotTracks,
      hipsTrack: data.hipsTrack,
      animRestHipsY: data.restHipsY,
      time: 0,
      playing: false,
      selectedKey: null,
    });
  },

  newAnim: () => {
    get().pushHistory();
    clearManipulated();
    set((st) => ({
      animName: 'New animation',
      duration: DEFAULT_DURATION,
      rotTracks: {},
      hipsTrack: [],
      animRestHipsY: st.restHipsPos.y || 1,
      time: 0,
      playing: false,
      selectedKey: null,
    }));
  },
}));

// Tiny sample animation (a wave) so users can immediately try playback/scrub.
export function makeSampleData(): VrmaData {
  const qz = (deg: number, axis: 'x' | 'y' | 'z' = 'z'): Quat => {
    const r = (deg * Math.PI) / 180;
    const v = [0, 0, 0];
    v[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] = Math.sin(r / 2);
    return [v[0], v[1], v[2], Math.cos(r / 2)] as Quat;
  };
  const slerp = (a: Quat, b: Quat, t: number): Quat => {
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b;
    if (dot < 0) {
      bb = [-b[0], -b[1], -b[2], -b[3]] as Quat;
      dot = -dot;
    }
    const k0 = 1 - t;
    const k1 = dot > 0.9995 ? t : Math.sin(t * Math.PI / 2) * 1;
    const out: Quat = [
      a[0] * k0 + bb[0] * k1,
      a[1] * k0 + bb[1] * k1,
      a[2] * k0 + bb[2] * k1,
      a[3] * k0 + bb[3] * k1,
    ];
    const len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    return [out[0] / len, out[1] / len, out[2] / len, out[3] / len];
  };

  const duration = 2.4;
  const fps = 30;
  const steps = Math.round(duration * fps);
  const rightUpper: RotKey[] = [];
  const rightLower: RotKey[] = [];
  const head: RotKey[] = [];
  const spine: RotKey[] = [];

  const RAISE = qz(75); // raise right arm sideways/up
  const WAVE_A = qz(0, 'y');
  const WAVE_B = qz(55, 'y');
  const HEAD_L = qz(-10);
  const HEAD_R = qz(10);
  const SPINE_TWIST = qz(-8, 'y');

  for (let i = 0; i <= steps; i++) {
    const t = i / fps;
    const phase = i / steps;
    const raiseEase = Math.min(1, phase * 4); // raise arm in first quarter
    const wave = (Math.sin(phase * Math.PI * 2 * 3) + 1) / 2; // 3 waves
    const idle = (Math.sin(phase * Math.PI * 2 * 1.5) + 1) / 2;
    rightUpper.push({ id: allocKeyId(), t, q: slerp([0, 0, 0, 1], RAISE, raiseEase) });
    rightLower.push({ id: allocKeyId(), t, q: slerp(WAVE_A, WAVE_B, raiseEase >= 1 ? wave : 0) });
    head.push({ id: allocKeyId(), t, q: slerp(HEAD_L, HEAD_R, idle) });
    spine.push({ id: allocKeyId(), t, q: slerp([0, 0, 0, 1], SPINE_TWIST, idle) });
  }

  return {
    name: 'Sample wave',
    duration,
    rotTracks: {
      rightUpperArm: rightUpper,
      rightLowerArm: rightLower,
      head,
      spine,
    },
    hipsTrack: [],
    restHipsY: 1,
  };
}
