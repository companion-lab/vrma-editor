import { create } from 'zustand';
import type { VRM } from '@pixiv/three-vrm';
import { Vector3 } from 'three';

// --- UI layout (persisted) ---
const UI_KEY = 'vrma-editor-ui';
const MODEL_KEY = 'vrma-editor-model';
export type Theme = 'dark' | 'light';
interface UILayout {
  leftOpen: boolean;
  rightOpen: boolean;
  timelineH: number;
  leftW: number;
  rightW: number;
  theme: Theme;
}
const DEFAULT_UI: UILayout = { leftOpen: true, rightOpen: true, timelineH: 218, leftW: 220, rightW: 270, theme: 'dark' };

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
        theme: v.theme === 'light' ? 'light' : 'dark',
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
import type { Bez, Ease, ExprKey, PosKey, Quat, RotKey, VrmaData, Vec3 } from './lib/vrma/parse';
import { allocKeyId, DEFAULT_BEZ } from './lib/vrma/parse';
import {
  applyExpressions,
  applyPose,
  captureHipsPosition,
  captureLivePose,
  captureQuat,
  clearManipulated,
  manipulatedBones,
  manipulatedExpressions,
  resetToRestPose,
  restoreLivePose,
  type LivePoseSnapshot,
} from './lib/animation';
import { BONE_ORDER, BONE_ORDER_INDEX } from './lib/humanoid';
import { applyExpressionWeight, syncModelEdits } from './lib/vrmedit/live';

export interface Snapshot {
  animName: string;
  duration: number;
  rotTracks: Partial<Record<string, RotKey[]>>;
  hipsTrack: PosKey[];
  exprTracks: Record<string, ExprKey[]>;
  animRestHipsY: number;
  modelEdits: ModelEdits;
  /** Live (unkeyed) pose — manipulated bones/expressions and their current
   *  transforms — so undo/redo covers changes that aren't keyed yet. */
  livePose: LivePoseSnapshot;
}

// Stroke coalescing for history: continuous inputs (color pickers, sliders,
// typing) push a tagged entry; repeats of the same tag inside a sliding
// window join the stroke instead of flooding the undo stack.
const COALESCE_MS = 600;
let lastPush: { tag: string; at: number } | null = null;

export type TrackId = string; // bone name, HIPS_TRACK_ID for hips translation,
// or `expr:<name>` for an expression track
export const HIPS_TRACK_ID = '__hips__';
export const EXPR_TRACK_PREFIX = 'expr:';
export const isExprTrack = (track: TrackId) => track.startsWith(EXPR_TRACK_PREFIX);
export const exprTrackId = (name: string) => EXPR_TRACK_PREFIX + name;
export const exprNameOf = (track: TrackId) => track.slice(EXPR_TRACK_PREFIX.length);

/** Static (rest-face) weight an expression falls back to when its animation
 *  track disappears: the model edit if any, else the file's baked value. */
function staticExpressionWeight(
  s: { modelEdits: ModelEdits; modelBakedExpressions: Record<string, number> },
  name: string,
): number {
  return s.modelEdits.expressions[name] ?? s.modelBakedExpressions[name] ?? 0;
}

export interface Status {
  kind: 'info' | 'ok' | 'error';
  msg: string;
  seq: number;
}

interface EditorState {
  // model
  vrm: VRM | null;
  restHipsPos: Vector3;
  /** Rest height (metres) of the lowest foot/toe node — with restHipsPos.y this
   *  is the leg drop the hips lift compensates when the whole body is scaled. */
  restFeetY: number;
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
  rightTab: 'pose' | 'motion' | 'model' | 'ai';

  // animation
  animName: string;
  duration: number;
  rotTracks: Partial<Record<string, RotKey[]>>;
  hipsTrack: PosKey[];
  /** Expression (blendshape) name (VRM 1.0 naming) -> sorted keys. */
  exprTracks: Record<string, ExprKey[]>;
  /** Rest hips height (Y) of the rig the animation was authored on. */
  animRestHipsY: number;

  /** Motion-reference video loaded via the toolbar (blob URL). Not part of
   *  undo/history — it is a source, not editor content. */
  motionVideoUrl: string | null;
  motionVideoName: string | null;

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
  /** Multi-key selection (time-range marquee / Alt+click column). selectedKey
   *  stays the primary; dragging any selected key moves them all together. */
  selectedKeys: { track: TrackId; id: number }[];
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
  theme: Theme;
  setTheme: (t: Theme) => void;

  // actions
  setVrm: (vrm: VRM | null, restHips: Vector3, restFeetY: number, name: string) => void;
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
  setRightTab: (tab: 'pose' | 'motion' | 'model' | 'ai') => void;
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
  setMotionVideo: (url: string | null, name: string | null) => void;

  selectBone: (bone: string | null) => void;
  toggleBoneSelection: (bone: string) => void;
  selectBoneRange: (bone: string) => void;
  selectKey: (track: TrackId, id: number | null) => void;
  /** Select every key of every track whose time is inside [t0, t1] (a marquee
   *  band, or one instant for Alt+click on a key — "all motion at 0.8s"). */
  selectKeysInRange: (t0: number, t1: number) => void;
  toggleKeySelection: (track: TrackId, id: number) => void;
  /** Select an arbitrary key set (the 2D drag rectangle). 'add' unions with
   *  the current selection, like Ctrl-drag in a file explorer. */
  selectKeys: (refs: { track: TrackId; id: number }[], mode?: 'replace' | 'add') => void;
  clearKeySelection: () => void;
  /** Group-drag primitive: set every key in `snapshot` (key times captured at
   *  drag start) to snapshot.t + delta, shifted as one block (spacing
   *  preserved) and clamped so no key leaves [0, duration]. The delta is
   *  always measured against the same snapshot, so repeated pointer moves are
   *  idempotent — no accumulation drift, and a block pinned at a clip edge
   *  follows the cursor back exactly. */
  moveKeySnapshot: (snapshot: { track: TrackId; id: number; t: number }[], delta: number) => void;

  /** Called at the start of a manipulation stroke (gizmo drag, slider
   *  pointer-down) with the tag its manipulate* calls will use: snapshots the
   *  pre-stroke state once so the whole stroke is a single undo step —
   *  whether or not auto-key is going to record it. */
  beginPoseStroke: (tag?: string) => void;
  manipulateBone: (bone: string, kind?: 'rot' | 'hipsPos' | 'both') => void;
  /** Live edit of an expression weight from the animation UI (Pose tab
   *  sliders): marks it as manipulated (playback sampler skips it) and, with
   *  auto-key on, keys it at the playhead. */
  manipulateExpression: (name: string, weight: number) => void;
  resetPose: () => void;

  /** Snapshot the current state onto the undo stack (clearing redo). With a
   *  `tag`, consecutive pushes of the same tag within a short window coalesce
   *  into one step — used by continuous inputs (sliders, color pickers). */
  pushHistory: (tag?: string) => void;
  undo: () => void;
  redo: () => void;

  snapTime: (t: number) => number;
  keySelectedBone: () => void;
  keyAllBones: () => void;
  upsertRotKey: (bone: string, q: Quat, opts?: { history?: boolean }) => void;
  upsertHipsKey: (p: Vec3, opts?: { history?: boolean }) => void;
  /** Key one expression's current weight at the snapped playhead (upsert). */
  upsertExprKey: (name: string, w: number, opts?: { history?: boolean }) => void;
  deleteSelectedKey: () => void;
  deleteBoneKeys: (bone: string) => void;
  deleteSelectedBonesKeys: () => void;
  moveKey: (track: TrackId, id: number, t: number) => void;
  setKeyEase: (track: TrackId, id: number, ease: Ease, bez?: Bez, opts?: { history?: boolean }) => void;
  setTrackEase: (track: TrackId, ease: Ease, bez?: Bez, opts?: { history?: boolean }) => void;

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
  restFeetY: 0,
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
  exprTracks: {},
  animRestHipsY: 1,

  motionVideoUrl: null,
  motionVideoName: null,

  time: 0,
  playing: false,
  loop: true,
  autoKey: false,
  showSkeleton: true,
  snap: 1 / 30,
  selectedBone: null,
  selectedBones: [],
  selectedKey: null,
  selectedKeys: [],
  poseTick: 0,

  status: null,
  past: [],
  future: [],

  ...loadUI(),
  setLeftOpen: (v) =>
    set((st) => {
      const ui = { leftOpen: v, rightOpen: st.rightOpen, timelineH: st.timelineH, leftW: st.leftW, rightW: st.rightW, theme: st.theme };
      saveUI(ui);
      return ui;
    }),
  setRightOpen: (v) =>
    set((st) => {
      const ui = { leftOpen: st.leftOpen, rightOpen: v, timelineH: st.timelineH, leftW: st.leftW, rightW: st.rightW, theme: st.theme };
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
        theme: st.theme,
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
        theme: st.theme,
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
        theme: st.theme,
      };
      saveUI(ui);
      return ui;
    }),
  setTheme: (t) =>
    set((st) => {
      const ui = {
        leftOpen: st.leftOpen,
        rightOpen: st.rightOpen,
        timelineH: st.timelineH,
        leftW: st.leftW,
        rightW: st.rightW,
        theme: t,
      };
      saveUI(ui);
      return ui;
    }),

  setVrm: (vrm, restHips, restFeetY, name) =>
    set((st) => {
      // A fresh authoring session uses the model's own rest height; an
      // already-loaded animation keeps the rest height it was authored with.
      const isEmpty =
        Object.values(st.rotTracks).every((k) => (k?.length ?? 0) === 0) &&
        st.hipsTrack.length === 0 &&
        Object.values(st.exprTracks).every((k) => (k?.length ?? 0) === 0);
      return {
        vrm,
        restHipsPos: restHips,
        restFeetY,
        modelName: name,
        modelLoading: false,
        ...(isEmpty ? { animRestHipsY: restHips.y || 1 } : {}),
      };
    }),
  setModelUrl: (url, name) => {
    if (url) saveLastModel(url, name);
    // A different model invalidates all live edits, the cached original, and
    // the undo stack (restoring the old model's edits/tracks onto the new one
    // would be wrong).
    lastPush = null;
    set({
      modelUrl: url,
      modelName: name,
      modelLoading: true,
      vrm: null,
      modelEdits: clone(EMPTY_EDITS),
      originalModelBytes: null,
      modelMeta: null,
      modelAssociations: null,
      modelBakedExpressions: {},
      rightTab: 'pose',
      past: [],
      future: [],
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

  setMaterialEdit: (matName, patch) => {
    get().pushHistory(`material:${matName}`);
    set((s) => ({
      modelEdits: {
        ...s.modelEdits,
        materials: {
          ...s.modelEdits.materials,
          [matName]: { ...s.modelEdits.materials[matName], ...patch },
        },
      },
    }));
  },
  resetMaterialEdit: (matName) => {
    get().pushHistory();
    set((s) => {
      const materials = { ...s.modelEdits.materials };
      delete materials[matName];
      return { modelEdits: { ...s.modelEdits, materials } };
    });
  },

  setMeshHidden: (meshName, hidden) => {
    get().pushHistory('visibility');
    set((s) => {
      const list = hidden
        ? s.modelEdits.hiddenMeshes.includes(meshName)
          ? s.modelEdits.hiddenMeshes
          : [...s.modelEdits.hiddenMeshes, meshName]
        : s.modelEdits.hiddenMeshes.filter((n) => n !== meshName);
      return { modelEdits: { ...s.modelEdits, hiddenMeshes: list } };
    });
  },

  setPartHidden: (partId, hidden) => {
    get().pushHistory('visibility');
    set((s) => {
      const list = hidden
        ? s.modelEdits.hiddenParts.includes(partId)
          ? s.modelEdits.hiddenParts
          : [...s.modelEdits.hiddenParts, partId]
        : s.modelEdits.hiddenParts.filter((p) => p !== partId);
      return { modelEdits: { ...s.modelEdits, hiddenParts: list } };
    });
  },

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
    get().pushHistory();
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

  setExpressionEdit: (name, weight) => {
    get().pushHistory(`expression:${name}`);
    set((s) => ({
      // Always record — a 0 must be able to override a weight baked into the file.
      modelEdits: { ...s.modelEdits, expressions: { ...s.modelEdits.expressions, [name]: weight } },
    }));
  },
  resetExpressionEdit: (name) => {
    get().pushHistory();
    set((s) => {
      const expressions = { ...s.modelEdits.expressions };
      delete expressions[name];
      return { modelEdits: { ...s.modelEdits, expressions } };
    });
  },
  resetAllExpressionEdits: () => {
    get().pushHistory();
    set((s) => ({ modelEdits: { ...s.modelEdits, expressions: {} } }));
  },

  setMetaEdit: (field, value) => {
    get().pushHistory(`meta:${field}`);
    set((s) => {
      const meta = { ...s.modelEdits.meta };
      if (value === '') delete meta[field];
      else meta[field] = value;
      return { modelEdits: { ...s.modelEdits, meta } };
    });
  },

  setBoneScale: (bone, factor) => {
    // Shared tag across bones: proportion groups set several bones per drag,
    // and that should collapse to a single undo step.
    get().pushHistory('boneScale');
    set((s) => {
      const boneScale = { ...s.modelEdits.boneScale };
      if (Math.abs(factor - 1) < 0.005) delete boneScale[bone];
      else boneScale[bone] = factor;
      return { modelEdits: { ...s.modelEdits, boneScale } };
    });
  },

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
  setMotionVideo: (url, name) => set({ motionVideoUrl: url, motionVideoName: name }),

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
    set({
      selectedKey: id == null ? null : { track, id },
      selectedKeys: id == null ? [] : [{ track, id }],
    }),

  // Every key (all tracks, including the hips position track) whose time is
  // inside the window. A degenerate window (t0 === t1, Alt+click) widens to
  // the current snap cell so "all motion at 0.8s" grabs the whole column
  // without catching neighbouring frames.
  selectKeysInRange: (t0, t1) => {
    const s = get();
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    const eps = hi - lo > 0 ? (s.snap > 0 ? s.snap / 2 : 0.005) : s.snap > 0 ? s.snap / 3 : 0.005;
    const refs: { track: TrackId; id: number }[] = [];
    for (const [bone, keys] of Object.entries(s.rotTracks)) {
      for (const k of keys ?? []) {
        if (k.t >= lo - eps && k.t <= hi + eps) refs.push({ track: bone, id: k.id });
      }
    }
    for (const k of s.hipsTrack) {
      if (k.t >= lo - eps && k.t <= hi + eps) refs.push({ track: HIPS_TRACK_ID, id: k.id });
    }
    for (const [name, keys] of Object.entries(s.exprTracks)) {
      for (const k of keys) {
        if (k.t >= lo - eps && k.t <= hi + eps) refs.push({ track: exprTrackId(name), id: k.id });
      }
    }
    if (refs.length === 0) {
      set({ selectedKeys: [], selectedKey: null });
      get().setStatus('info', 'No keyframes in that time range');
      return;
    }
    set({ selectedKeys: refs, selectedKey: refs[0] });
    get().setStatus(
      'ok',
      `Selected ${refs.length} key${refs.length === 1 ? '' : 's'} — drag any of them to move together`,
    );
  },

  toggleKeySelection: (track, id) =>
    set((s) => {
      const exists = s.selectedKeys.some((r) => r.track === track && r.id === id);
      if (exists) {
        const selectedKeys = s.selectedKeys.filter((r) => !(r.track === track && r.id === id));
        const wasPrimary = s.selectedKey?.track === track && s.selectedKey?.id === id;
        return {
          selectedKeys,
          selectedKey: wasPrimary ? (selectedKeys[selectedKeys.length - 1] ?? null) : s.selectedKey,
        };
      }
      return { selectedKeys: [...s.selectedKeys, { track, id }], selectedKey: { track, id } };
    }),

  clearKeySelection: () => set({ selectedKeys: [], selectedKey: null }),

  selectKeys: (refs, mode = 'replace') =>
    set((s) => {
      let next = refs;
      if (mode === 'add' && s.selectedKeys.length > 0) {
        const seen = new Set(s.selectedKeys.map((r) => `${r.track}:${r.id}`));
        next = [...s.selectedKeys];
        for (const r of refs) {
          const key = `${r.track}:${r.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            next.push(r);
          }
        }
      }
      return { selectedKeys: next, selectedKey: next[next.length - 1] ?? null };
    }),

  // Group drag: every key in the snapshot (times captured at drag start) is
  // placed at snapshot.t + delta — shifted as one block, spacing preserved,
  // clamped to the clip, re-sorted per track. Because the delta is always
  // measured against the same snapshot, repeated pointer moves are
  // idempotent: the block tracks the cursor 1:1 instead of accumulating
  // deltas, and a block pinned at a clip edge follows the cursor back
  // exactly.
  moveKeySnapshot: (snapshot, delta) => {
    if (snapshot.length === 0) return;
    let minT = Infinity;
    let maxT = -Infinity;
    for (const r of snapshot) {
      minT = Math.min(minT, r.t);
      maxT = Math.max(maxT, r.t);
    }
    const d = Math.min(Math.max(delta, -minT), get().duration - maxT);
    if (Math.abs(d) < 1e-9) return;
    const byTrack = new Map<string, Map<number, number>>();
    for (const r of snapshot) {
      const m = byTrack.get(r.track) ?? new Map<number, number>();
      m.set(r.id, r.t + d);
      byTrack.set(r.track, m);
    }
    const shift = <K extends { id: number; t: number }>(keys: K[], targets: Map<number, number>): K[] =>
      keys.map((k) => (targets.has(k.id) ? { ...k, t: targets.get(k.id)! } : k)).sort((a, b) => a.t - b.t);
    set((st) => {
      const hipsTargets = byTrack.get(HIPS_TRACK_ID);
      const hipsTrack = hipsTargets ? shift(st.hipsTrack, hipsTargets) : st.hipsTrack;
      let rotTracks: Partial<Record<string, RotKey[]>> | null = null;
      for (const [bone, keys] of Object.entries(st.rotTracks)) {
        const targets = byTrack.get(bone);
        if (!targets) continue;
        rotTracks = rotTracks ?? { ...st.rotTracks };
        rotTracks[bone] = shift(keys ?? [], targets);
      }
      let exprTracks: Record<string, ExprKey[]> | null = null;
      for (const [name, keys] of Object.entries(st.exprTracks)) {
        const targets = byTrack.get(exprTrackId(name));
        if (!targets) continue;
        exprTracks = exprTracks ?? { ...st.exprTracks };
        exprTracks[name] = shift(keys, targets);
      }
      return { hipsTrack, ...(rotTracks ? { rotTracks } : {}), ...(exprTracks ? { exprTracks } : {}) };
    });
  },

  // Called at the start of a manipulation stroke (gizmo drag, slider drag):
  // snapshots the pre-stroke state so the whole stroke is a single undo step.
  // The tagged push coalesces with the stroke's manipulation pushes — and it
  // is taken unconditionally, so poses are undoable even when auto-key is off
  // and nothing is keyed ("saved") yet.
  beginPoseStroke: (tag) => {
    get().pushHistory(tag);
  },

  // Live edit of a normalized bone from the UI (gizmo, sliders). Marks the
  // bone as manually manipulated (playback sampler skips it) and, with
  // auto-key on, records it — converting live rig space to canonical space.
  manipulateBone: (bone, kind) => {
    const st = get();
    if (!st.vrm) return;
    // Tagged history push: continuous input coalesces into one undo step, and
    // every path (gizmo, sliders, typed numbers, AI tools) is captured even
    // when auto-key is off and the pose isn't keyed yet.
    st.pushHistory(`pose:${bone}`);
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

  manipulateExpression: (name, weight) => {
    const st = get();
    if (!st.vrm) return;
    st.pushHistory(`pose:expr:${name}`);
    manipulatedExpressions.add(name);
    if (st.autoKey) st.upsertExprKey(name, weight, { history: false });
    st.bumpPose();
  },

  resetPose: () => {
    const { vrm, restHipsPos } = get();
    if (!vrm) return;
    // Undoable from every caller (button, AI tools) — the snapshot keeps the
    // pre-reset pose including which bones were manipulated.
    get().pushHistory('pose');
    resetToRestPose(vrm, restHipsPos);
    get().bumpPose();
  },

  pushHistory: (tag) => {
    if (tag) {
      const now = Date.now();
      if (lastPush && lastPush.tag === tag && now - lastPush.at < COALESCE_MS) {
        lastPush.at = now; // sliding window: one drag = one undo step
        return;
      }
      lastPush = { tag, at: now };
    } else {
      lastPush = null;
    }
    set((s) => ({
      past: [...s.past.slice(-99), {
        animName: s.animName,
        duration: s.duration,
        rotTracks: clone(s.rotTracks),
        hipsTrack: clone(s.hipsTrack),
        exprTracks: clone(s.exprTracks),
        animRestHipsY: s.animRestHipsY,
        modelEdits: clone(s.modelEdits),
        livePose: captureLivePose(s.vrm),
      }],
      future: [],
    }));
  },

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      lastPush = null;
      // Capture the current live pose BEFORE restoring: restoreLivePose
      // repopulates the manipulated sets from the snapshot, so capturing
      // afterwards would record the restored state, not the state redo must
      // bring back.
      const livePose = captureLivePose(s.vrm);
      if (s.vrm) {
        syncModelEdits(s.vrm, prev.modelEdits, s.modelEdits);
        // Restore the unkeyed pose of the state being returned to (instead of
        // the old blanket clearManipulated, which dropped manipulated bones
        // even when the restored state still had them).
        restoreLivePose(s.vrm, prev.livePose);
        // Re-apply the restored animation right away: the poseTick bump below
        // re-renders the pose-bound UI, which would otherwise read the
        // pre-undo nodes until the next render-loop tick.
        const anim = {
          name: prev.animName,
          duration: prev.duration,
          rotTracks: prev.rotTracks,
          hipsTrack: prev.hipsTrack,
          exprTracks: prev.exprTracks,
          restHipsY: prev.animRestHipsY,
        };
        const time = Math.min(s.time, prev.duration);
        applyPose(s.vrm, anim, time, s.restHipsPos, prev.animRestHipsY);
        applyExpressions(s.vrm, anim, time);
      }
      return {
        past: s.past.slice(0, -1),
        future: [...s.future, {
          animName: s.animName,
          duration: s.duration,
          rotTracks: clone(s.rotTracks),
          hipsTrack: clone(s.hipsTrack),
          exprTracks: clone(s.exprTracks),
          animRestHipsY: s.animRestHipsY,
          modelEdits: clone(s.modelEdits),
          livePose,
        }],
        animName: prev.animName,
        duration: prev.duration,
        rotTracks: prev.rotTracks,
        hipsTrack: prev.hipsTrack,
        exprTracks: prev.exprTracks,
        animRestHipsY: prev.animRestHipsY,
        modelEdits: prev.modelEdits,
        time: Math.min(s.time, prev.duration),
        poseTick: s.poseTick + 1,
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[s.future.length - 1];
      if (!next) return s;
      lastPush = null;
      // Same ordering as undo: capture before the restore overwrites the sets.
      const livePose = captureLivePose(s.vrm);
      if (s.vrm) {
        syncModelEdits(s.vrm, next.modelEdits, s.modelEdits);
        restoreLivePose(s.vrm, next.livePose);
        // Same as undo: sample the restored state before the UI re-renders.
        const anim = {
          name: next.animName,
          duration: next.duration,
          rotTracks: next.rotTracks,
          hipsTrack: next.hipsTrack,
          exprTracks: next.exprTracks,
          restHipsY: next.animRestHipsY,
        };
        const time = Math.min(s.time, next.duration);
        applyPose(s.vrm, anim, time, s.restHipsPos, next.animRestHipsY);
        applyExpressions(s.vrm, anim, time);
      }
      return {
        future: s.future.slice(0, -1),
        past: [...s.past, {
          animName: s.animName,
          duration: s.duration,
          rotTracks: clone(s.rotTracks),
          hipsTrack: clone(s.hipsTrack),
          exprTracks: clone(s.exprTracks),
          animRestHipsY: s.animRestHipsY,
          modelEdits: clone(s.modelEdits),
          livePose,
        }],
        animName: next.animName,
        duration: next.duration,
        rotTracks: next.rotTracks,
        hipsTrack: next.hipsTrack,
        exprTracks: next.exprTracks,
        animRestHipsY: next.animRestHipsY,
        modelEdits: next.modelEdits,
        time: Math.min(s.time, next.duration),
        poseTick: s.poseTick + 1,
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
        selectedKeys: [{ track: bone, id }],
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
        selectedKeys: [{ track: HIPS_TRACK_ID, id }],
      };
    });
  },

  upsertExprKey: (name, w, opts) => {
    const { history = true } = opts ?? {};
    const t = get().snapTime(get().time);
    if (history) get().pushHistory();
    set((s) => {
      const keys = [...(s.exprTracks[name] ?? [])];
      const existing = keys.findIndex((k) => Math.abs(k.t - t) < 1e-6);
      let id: number;
      if (existing >= 0) {
        keys[existing] = { ...keys[existing], w };
        id = keys[existing].id;
      } else {
        id = allocKeyId();
        keys.push({ id, t, w });
        keys.sort((a, b) => a.t - b.t);
      }
      return {
        exprTracks: { ...s.exprTracks, [name]: keys },
        selectedKey: { track: exprTrackId(name), id },
        selectedKeys: [{ track: exprTrackId(name), id }],
      };
    });
  },

  // Del key / trash button. With a multi-key selection (marquee) removes all
  // of them in one undo step; otherwise just the primary selected key.
  deleteSelectedKey: () => {
    const s = get();
    const multi = s.selectedKeys;
    if (multi.length > 1) {
      s.pushHistory();
      // Expression tracks emptied by the deletion fall back to their static
      // (rest-face) weight so the face doesn't freeze mid-expression.
      const emptied: string[] = [];
      set((st) => {
        const hipsIds = new Set(multi.filter((r) => r.track === HIPS_TRACK_ID).map((r) => r.id));
        const hipsTrack =
          hipsIds.size > 0 ? st.hipsTrack.filter((k) => !hipsIds.has(k.id)) : st.hipsTrack;
        let rotTracks: Partial<Record<string, RotKey[]>> | null = null;
        for (const [bone, keys] of Object.entries(st.rotTracks)) {
          if (!keys) continue;
          const ids = new Set(multi.filter((r) => r.track === bone).map((r) => r.id));
          if (ids.size === 0) continue;
          rotTracks = rotTracks ?? { ...st.rotTracks };
          rotTracks[bone] = keys.filter((k) => !ids.has(k.id));
        }
        let exprTracks: Record<string, ExprKey[]> | null = null;
        for (const [track, keys] of Object.entries(st.exprTracks)) {
          const ids = new Set(multi.filter((r) => r.track === exprTrackId(track)).map((r) => r.id));
          if (ids.size === 0) continue;
          const next = keys.filter((k) => !ids.has(k.id));
          exprTracks = exprTracks ?? { ...st.exprTracks };
          if (next.length === 0) {
            delete exprTracks[track];
            emptied.push(track);
          } else {
            exprTracks[track] = next;
          }
        }
        return {
          ...(rotTracks ? { rotTracks } : {}),
          ...(exprTracks ? { exprTracks } : {}),
          hipsTrack,
          selectedKeys: [],
          selectedKey: null,
        };
      });
      const vrm = get().vrm;
      if (vrm) {
        for (const name of emptied) {
          manipulatedExpressions.delete(name);
          applyExpressionWeight(vrm, name, staticExpressionWeight(get(), name));
        }
      }
      return;
    }
    const sel = s.selectedKey;
    if (!sel) return;
    get().pushHistory();
    let emptiedName: string | null = null;
    set((st) => {
      if (sel.track === HIPS_TRACK_ID) {
        return {
          hipsTrack: st.hipsTrack.filter((k) => k.id !== sel.id),
          selectedKey: null,
          selectedKeys: [],
        };
      }
      if (isExprTrack(sel.track)) {
        const name = exprNameOf(sel.track);
        const keys = st.exprTracks[name];
        if (!keys) return st;
        const next = keys.filter((k) => k.id !== sel.id);
        const exprTracks = { ...st.exprTracks };
        if (next.length === 0) {
          delete exprTracks[name];
          emptiedName = name;
        } else {
          exprTracks[name] = next;
        }
        return { exprTracks, selectedKey: null, selectedKeys: [] };
      }
      const keys = st.rotTracks[sel.track];
      if (!keys) return st;
      return {
        rotTracks: { ...st.rotTracks, [sel.track]: keys.filter((k) => k.id !== sel.id) },
        selectedKey: null,
        selectedKeys: [],
      };
    });
    if (emptiedName) {
      const st = get();
      manipulatedExpressions.delete(emptiedName);
      if (st.vrm) applyExpressionWeight(st.vrm, emptiedName, staticExpressionWeight(st, emptiedName));
    }
  },

  deleteBoneKeys: (bone) => {
    const s = get();
    if (bone === HIPS_TRACK_ID) {
      if (s.hipsTrack.length === 0) return;
      s.pushHistory();
      set({ hipsTrack: [], selectedKey: null });
      return;
    }
    if (isExprTrack(bone)) {
      const name = exprNameOf(bone);
      if ((s.exprTracks[name]?.length ?? 0) === 0) return;
      s.pushHistory();
      const exprTracks = { ...s.exprTracks };
      delete exprTracks[name];
      manipulatedExpressions.delete(name);
      if (s.vrm) applyExpressionWeight(s.vrm, name, staticExpressionWeight(s, name));
      set((st) => ({
        exprTracks,
        selectedKey: st.selectedKey?.track === bone ? null : st.selectedKey,
      }));
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
      if (isExprTrack(track)) {
        const name = exprNameOf(track);
        const keys = s.exprTracks[name];
        if (!keys) return s;
        const next = update(keys);
        return next ? { exprTracks: { ...s.exprTracks, [name]: next } } : s;
      }
      const keys = s.rotTracks[track];
      if (!keys) return s;
      const next = update(keys);
      return next ? { rotTracks: { ...s.rotTracks, [track]: next } } : s;
    });
  },

  // Shift whole tracks in time. One shared dt so spacing between the tracks
  // is preserved; clamped so the outermost keys stay inside the clip.
  setKeyEase: (track, id, ease, bez, opts) => {
    if (opts?.history !== false) get().pushHistory();
    const apply = <T extends { ease?: Ease; bez?: Bez }>(k: T): T => ({
      ...k,
      ease,
      bez: ease === 'custom' ? (bez ?? k.bez ?? DEFAULT_BEZ) : undefined,
    });
    set((s) => {
      if (track === HIPS_TRACK_ID) {
        return {
          hipsTrack: s.hipsTrack.map((k) => (k.id === id ? apply(k) : k)),
        };
      }
      if (isExprTrack(track)) {
        const name = exprNameOf(track);
        const keys = s.exprTracks[name];
        if (!keys) return s;
        return {
          exprTracks: { ...s.exprTracks, [name]: keys.map((k) => (k.id === id ? apply(k) : k)) },
        };
      }
      const keys = s.rotTracks[track];
      if (!keys) return s;
      return {
        rotTracks: {
          ...s.rotTracks,
          [track]: keys.map((k) => (k.id === id ? apply(k) : k)),
        },
      };
    });
  },

  setTrackEase: (track, ease, bez, opts) => {
    if (opts?.history !== false) get().pushHistory();
    const apply = <T extends { ease?: Ease; bez?: Bez }>(k: T): T => ({
      ...k,
      ease,
      bez: ease === 'custom' ? (bez ?? k.bez ?? DEFAULT_BEZ) : undefined,
    });
    set((s) => {
      if (track === HIPS_TRACK_ID) {
        return { hipsTrack: s.hipsTrack.map(apply) };
      }
      if (isExprTrack(track)) {
        const name = exprNameOf(track);
        const keys = s.exprTracks[name];
        if (!keys) return s;
        return { exprTracks: { ...s.exprTracks, [name]: keys.map(apply) } };
      }
      const keys = s.rotTracks[track];
      if (!keys) return s;
      return {
        rotTracks: { ...s.rotTracks, [track]: keys.map(apply) },
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
      exprTracks: s.exprTracks,
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
      exprTracks: data.exprTracks ?? {},
      animRestHipsY: data.restHipsY,
      time: 0,
      playing: false,
      selectedKey: null,
      selectedKeys: [],
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
      exprTracks: {},
      animRestHipsY: st.restHipsPos.y || 1,
      time: 0,
      playing: false,
      selectedKey: null,
      selectedKeys: [],
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

  // Z- (negative) raises right-side limbs within the screen plane: the right
  // arm rests along -X, so rotating toward +Y needs a negative Z angle.
  const RAISE = qz(-75); // raise right arm sideways/up
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
    exprTracks: {},
    restHipsY: 1,
  };
}
