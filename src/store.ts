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
  /** VRoid-style body-shape parameters (height, arm length, hip width…) →
   *  factor. Applied as a second pass over boneScale; see proportions.ts. */
  bodyShape: Record<string, number>;
  /** Face parameters (eyeSize / eyeHeight / eyeSpacing) → factor or offset;
   *  see appearance.ts and live.ts applyFaceShape. */
  face: Record<string, number>;
}

const EMPTY_EDITS: ModelEdits = {
  materials: {},
  hiddenMeshes: [],
  hiddenParts: [],
  expressions: {},
  meta: {},
  boneScale: {},
  bodyShape: {},
  face: {},
};

export function countModelEdits(edits: ModelEdits): number {
  return (
    Object.keys(edits.materials).length +
    edits.hiddenMeshes.length +
    edits.hiddenParts.length +
    Object.keys(edits.expressions).length +
    Object.keys(edits.meta).length +
    Object.keys(edits.boneScale).length +
    Object.keys(edits.bodyShape).length +
    Object.keys(edits.face).length
  );
}

// --- Outfit presets (persisted per model, see the Assets panel) ---

export interface OutfitPreset {
  name: string;
  hiddenMeshes: string[];
  hiddenParts: string[];
  /** Worn wardrobe parts captured with the outfit (undefined in old presets). */
  worn?: WornRef[];
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
import { applyAssetVisibilityAll, type PartCategory, type PartId } from './lib/vrmedit/parts';
import { computeReplaced, detachAllWorn, syncWorn, type WornRef } from './lib/wardrobe/wear';
import { AUTO_REPLACE_CATEGORIES } from './lib/wardrobe/sources';
import { bakeGroundFeet } from './lib/ground';

/** syncWorn + a status hint when a worn donor isn't loaded this session (its
 *  parts are silently absent until the donor file is available again). */
function syncWornHinted(vrm: VRM | null, worn: WornRef[]): void {
  const { missing } = syncWorn(vrm, worn);
  if (missing.length) {
    useEditor.getState().setStatus('info', `Wardrobe donors not loaded this session: ${missing.join(', ')}`);
  }
}

export interface Snapshot {
  animName: string;
  duration: number;
  rotTracks: Partial<Record<string, RotKey[]>>;
  hipsTrack: PosKey[];
  exprTracks: Record<string, ExprKey[]>;
  animRestHipsY: number;
  modelEdits: ModelEdits;
  /** Worn wardrobe parts — restored together with the hidden lists they hide. */
  worn: WornRef[];
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

/** Copied keyframes: one entry per source track, key times re-anchored to the
 *  block start (the earliest copied key) so paste offsets the whole block
 *  from the playhead while preserving spacing. */
export type KeyClipboard = { track: TrackId; keys: (RotKey | PosKey | ExprKey)[] }[];

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
  /** Wardrobe library entries (assets/wardrobe listing, like the model library). */
  wardrobeLibrary: { name: string; url: string }[];
  /** Parts currently worn from wardrobe donors. Part of undo/history; the
   *  same-category originals it hides live in modelEdits' hidden lists. */
  worn: WornRef[];
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
  /** Copied keyframes (copy/cut) — the source for pasteKeys. Not part of
   *  undo/history: it is scratch content, not editor state. */
  keyClipboard: KeyClipboard | null;
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
  fetchWardrobeLibrary: () => Promise<void>;
  wearPart: (donor: string, id: PartId, category: PartCategory) => void;
  unwearPart: (donor: string, id: PartId) => void;
  clearWorn: () => void;
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
  /** VRoid-style body-shape parameter → factor (see proportions.ts). */
  setBodyShape: (param: string, factor: number) => void;
  resetBodyShape: () => void;
  /** Face parameter (eyeSize / eyeHeight / eyeSpacing) → factor or offset. */
  setFaceShape: (param: string, value: number) => void;
  resetFaceShape: () => void;
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

  /** Copy the selected keyframes (the multi-selection, or the primary one)
   *  onto the internal clipboard. Returns true when anything was copied. */
  copySelectedKeys: () => boolean;
  /** Internal core of the copy actions: resolve refs to keys, group them by
   *  track, block-anchor to the earliest key and fill the clipboard. */
  copyKeyRefs: (refs: { track: TrackId; id: number }[]) => boolean;
  /** Copy every keyframe of one track (context menu — copy without touching
   *  the selection). Returns true when anything was copied. */
  copyTrackKeys: (track: TrackId) => boolean;
  /** Select every keyframe of one track (context menu — also selects the
   *  track's bone so the row highlights). */
  selectTrackKeys: (track: TrackId) => void;
  /** Paste the clipboard's keyframe block anchored at `atTime` (or the
   *  snapped playhead when omitted; pulled back so the block fits the clip).
   *  Keys landing on an existing key's time overwrite it (the upsert rule).
   *  One undo step; selects the pasted keys. */
  pasteKeys: (atTime?: number) => void;
  /** Copy the selection, then delete it — one undo step (via the delete). */
  cutSelectedKeys: () => void;
  /** Select every keyframe of every track (rotations, hips, expressions). */
  selectAllKeys: () => void;

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
  /** Re-solve the hips height track so the lowest foot/toe rests on the
   *  ground across the whole animation. Null when there is no model or no
   *  foot/toe bones to measure. One undo step. */
  groundFeet: () => { sampled: number; maxDrop: number; maxLift: number; hipsKeys: number } | null;
}

const clone = <T,>(v: T): T => structuredClone(v);

/** Merge copied keys into one track at `anchor` + each key's normalized time.
 *  An existing key at the same time (|Δt| < 1e-6 — the upsert rule the key
 *  buttons use) keeps its id but takes the copied value + ease; new keys get
 *  fresh ids. Appends the surviving key refs to `out` and keeps the track
 *  sorted, so the caller can select what was pasted. */
function mergePastedKeys<K extends { id: number; t: number }>(
  list: K[],
  copied: K[],
  anchor: number,
  track: TrackId,
  out: { track: TrackId; id: number }[],
): K[] {
  const next = [...list];
  for (const k of copied) {
    const t = anchor + k.t;
    const existing = next.findIndex((e) => Math.abs(e.t - t) < 1e-6);
    let id: number;
    if (existing >= 0) {
      id = next[existing].id;
      next[existing] = { ...k, t, id };
    } else {
      id = allocKeyId();
      next.push({ ...k, t, id });
    }
    out.push({ track, id });
  }
  next.sort((a, b) => a.t - b.t);
  return next;
}

const DEFAULT_DURATION = 5;

let statusSeq = 0;

export const useEditor = create<EditorState>()((set, get) => ({
  vrm: null,
  restHipsPos: new Vector3(),
  restFeetY: 0,
  // First-run default: the VRoid sample with a real body (base layers baked
  // in), so taking costume pieces off never leaves a bare mannequin.
  modelUrl: loadLastModel()?.url ?? '/models/AvatarSample_B.vrm',
  modelName: loadLastModel()?.name ?? 'AvatarSample_B.vrm',
  modelLoading: true,

  modelLibrary: [],
  textureLibrary: [],
  originalModelBytes: null,
  modelEdits: clone(EMPTY_EDITS),
  outfits: loadOutfits(),
  wardrobeLibrary: [],
  worn: [],
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
  keyClipboard: null,
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
    // would be wrong). Worn donor scenes detach with it.
    lastPush = null;
    detachAllWorn();
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
      worn: [],
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

  fetchWardrobeLibrary: async () => {
    set({ wardrobeLibrary: await listLibrary('/api/wardrobe', '/wardrobe') });
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
    const { modelName, modelEdits, worn } = get();
    const trimmed = name.trim();
    if (!trimmed) return;
    const preset: OutfitPreset = {
      name: trimmed,
      hiddenMeshes: [...modelEdits.hiddenMeshes],
      hiddenParts: [...modelEdits.hiddenParts],
      worn: worn.map((w) => ({ ...w })),
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
    const { modelName, vrm } = get();
    const preset = get().outfitsFor().presets.find((p) => p.name === name);
    if (!preset) return null;
    get().pushHistory();
    // Old presets have no worn list — keep whatever is currently worn.
    const worn = preset.worn ? preset.worn.map((w) => ({ ...w })) : get().worn;
    // Same-category originals of worn parts hide on top of the preset's lists.
    const replaced = computeReplaced(vrm, worn);
    const hiddenMeshes = [...preset.hiddenMeshes, ...replaced.replacedMeshes.filter((n) => !preset.hiddenMeshes.includes(n))];
    const hiddenParts = [...preset.hiddenParts, ...replaced.replacedParts.filter((p) => !preset.hiddenParts.includes(p))];
    set((s) => ({
      modelEdits: {
        ...s.modelEdits,
        hiddenMeshes,
        hiddenParts,
      },
      worn,
    }));
    syncWornHinted(vrm, worn);
    if (vrm) applyAssetVisibilityAll(vrm, hiddenMeshes, hiddenParts);
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

  // --- Wardrobe (wearing donor parts) ---
  //
  // Wearing a donor part hides the target's own same-category parts by adding
  // them to modelEdits' hidden lists (so export removes them, outfit presets
  // capture them and undo covers the change). Each WornRef records exactly the
  // ids ITS wear action added, so unwearing restores precisely and overlapping
  // wears (two donor hairs) only unhide when the last one is removed.

  wearPart: (donor, id, category) => {
    const { vrm, worn: prev, modelEdits } = get();
    if (prev.some((w) => w.donor === donor && w.id === id)) return;
    get().pushHistory();

    // One costume slot per category (VRoid behaviour): wearing a part replaces
    // the worn parts of the same category from OTHER donors. Same-donor pieces
    // of one category stack — a hairstyle split into a cap and a back mesh is
    // meant to be worn together. The ambiguous "other" category never
    // auto-replaces (accessories stack freely).
    const replaces = (AUTO_REPLACE_CATEGORIES as string[]).includes(category);
    const removed = replaces ? prev.filter((w) => w.category === category && w.donor !== donor) : [];
    const removedMeshes = new Set(removed.flatMap((w) => w.replacedMeshes));
    const removedParts = new Set(removed.flatMap((w) => w.replacedParts));
    const worn = [...prev.filter((w) => !removed.includes(w)), { donor, id, category, replacedMeshes: [], replacedParts: [] }];
    const entry = worn[worn.length - 1];
    // Hidden originals the removed entries had taken over go back into the
    // pool, so the new wear's own replace set records them exactly (unwear
    // then restores everything it should).
    const hiddenMeshes = modelEdits.hiddenMeshes.filter((n) => !removedMeshes.has(n));
    const hiddenParts = modelEdits.hiddenParts.filter((p) => !removedParts.has(p));
    const replaced = computeReplaced(vrm, worn);
    entry.replacedMeshes = replaced.replacedMeshes.filter((n) => !hiddenMeshes.includes(n));
    entry.replacedParts = replaced.replacedParts.filter((p) => !hiddenParts.includes(p));
    set((s) => ({
      worn,
      modelEdits: {
        ...s.modelEdits,
        hiddenMeshes: [...hiddenMeshes, ...entry.replacedMeshes],
        hiddenParts: [...hiddenParts, ...entry.replacedParts],
      },
    }));
    syncWornHinted(vrm, worn);
    if (vrm) applyAssetVisibilityAll(vrm, get().modelEdits.hiddenMeshes, get().modelEdits.hiddenParts);
  },

  unwearPart: (donor, id) => {
    const { vrm, worn: prev, modelEdits } = get();
    const entry = prev.find((w) => w.donor === donor && w.id === id);
    if (!entry) return;
    get().pushHistory();
    const remaining = prev.filter((w) => !(w.donor === donor && w.id === id));
    // final hidden = current hidden MINUS what this wear added, UNION what the
    // remaining worn parts still replace.
    const still = computeReplaced(vrm, remaining);
    const keptMeshes = modelEdits.hiddenMeshes.filter((n) => !entry.replacedMeshes.includes(n));
    const keptParts = modelEdits.hiddenParts.filter((p) => !entry.replacedParts.includes(p));
    const hiddenMeshes = [...keptMeshes, ...still.replacedMeshes.filter((n) => !keptMeshes.includes(n))];
    const hiddenParts = [...keptParts, ...still.replacedParts.filter((p) => !keptParts.includes(p))];
    set((s) => ({
      worn: remaining,
      modelEdits: { ...s.modelEdits, hiddenMeshes, hiddenParts },
    }));
    syncWornHinted(vrm, remaining);
    if (vrm) applyAssetVisibilityAll(vrm, hiddenMeshes, hiddenParts);
  },

  clearWorn: () => {
    const { vrm, worn: prev, modelEdits } = get();
    if (prev.length === 0) return;
    get().pushHistory();
    // Remove every hide any worn entry added.
    const addedMeshes = new Set(prev.flatMap((w) => w.replacedMeshes));
    const addedParts = new Set(prev.flatMap((w) => w.replacedParts));
    const hiddenMeshes = modelEdits.hiddenMeshes.filter((n) => !addedMeshes.has(n));
    const hiddenParts = modelEdits.hiddenParts.filter((p) => !addedParts.has(p));
    set((s) => ({
      worn: [],
      modelEdits: { ...s.modelEdits, hiddenMeshes, hiddenParts },
    }));
    syncWornHinted(vrm, []);
    if (vrm) applyAssetVisibilityAll(vrm, hiddenMeshes, hiddenParts);
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

  setBodyShape: (param, factor) => {
    // One drag = one undo step, same convention as setBoneScale.
    get().pushHistory('bodyShape');
    set((s) => {
      const bodyShape = { ...s.modelEdits.bodyShape };
      if (Math.abs(factor - 1) < 0.005) delete bodyShape[param];
      else bodyShape[param] = factor;
      return { modelEdits: { ...s.modelEdits, bodyShape } };
    });
  },

  resetBodyShape: () => {
    get().pushHistory('bodyShape');
    set((s) => ({ modelEdits: { ...s.modelEdits, bodyShape: {} } }));
  },

  setFaceShape: (param, value) => {
    get().pushHistory('faceShape');
    set((s) => {
      const face = { ...s.modelEdits.face };
      if (Math.abs(value) < 0.005 || (param === 'eyeSize' && Math.abs(value - 1) < 0.005)) delete face[param];
      else face[param] = value;
      return { modelEdits: { ...s.modelEdits, face } };
    });
  },

  resetFaceShape: () => {
    get().pushHistory('faceShape');
    set((s) => ({ modelEdits: { ...s.modelEdits, face: {} } }));
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

  // Ctrl/Cmd+C: copy the selected keyframes (marquee multi-selection, or just
  // the primary one) onto the internal clipboard, grouped by track with times
  // re-anchored to the earliest copied key so paste offsets the whole block
  // from the playhead. Stale refs (key deleted since selection) are skipped.
  copySelectedKeys: () => {
    const s = get();
    const refs = s.selectedKeys.length > 0 ? s.selectedKeys : s.selectedKey ? [s.selectedKey] : [];
    if (refs.length === 0) {
      s.setStatus('info', 'Nothing to copy — select keyframes on the timeline first');
      return false;
    }
    return get().copyKeyRefs(refs);
  },

  // Context menu: copy every key of one track without touching the selection.
  copyTrackKeys: (track) => {
    const s = get();
    const keys =
      track === HIPS_TRACK_ID
        ? s.hipsTrack
        : isExprTrack(track)
          ? (s.exprTracks[exprNameOf(track)] ?? [])
          : (s.rotTracks[track] ?? []);
    if (keys.length === 0) {
      s.setStatus('info', 'That track has no keyframes to copy');
      return false;
    }
    return get().copyKeyRefs(keys.map((k) => ({ track, id: k.id })));
  },

  // Context menu: select every key of one track; bone rows also select the
  // bone itself so the row highlights like a label click.
  selectTrackKeys: (track) => {
    const s = get();
    const keys =
      track === HIPS_TRACK_ID
        ? s.hipsTrack
        : isExprTrack(track)
          ? (s.exprTracks[exprNameOf(track)] ?? [])
          : (s.rotTracks[track] ?? []);
    if (keys.length === 0) {
      s.setStatus('info', 'That track has no keyframes to select');
      return;
    }
    const refs = keys.map((k) => ({ track, id: k.id }));
    set({ selectedKeys: refs, selectedKey: refs[0] });
    if (!isExprTrack(track) && track !== HIPS_TRACK_ID) get().selectBone(track);
  },

  // Shared copy core: resolve each ref to its key object, grouped by track.
  copyKeyRefs: (refs) => {
    const s = get();
    let t0 = Infinity;
    const picked = new Map<TrackId, (RotKey | PosKey | ExprKey)[]>();
    const pick = (track: TrackId, keys: (RotKey | PosKey | ExprKey)[] | undefined) => {
      if (!keys) return;
      for (const r of refs) {
        if (r.track !== track) continue;
        const k = keys.find((q) => q.id === r.id);
        if (!k) continue;
        t0 = Math.min(t0, k.t);
        const list = picked.get(track);
        if (list) list.push(k);
        else picked.set(track, [k]);
      }
    };
    for (const [bone, keys] of Object.entries(s.rotTracks)) pick(bone, keys);
    pick(HIPS_TRACK_ID, s.hipsTrack);
    for (const [name, keys] of Object.entries(s.exprTracks)) pick(exprTrackId(name), keys);
    if (picked.size === 0) {
      s.setStatus('info', 'Nothing to copy — the selected keyframes no longer exist');
      return false;
    }
    const clipboard: KeyClipboard = [];
    for (const [track, keys] of picked) {
      clipboard.push({
        track,
        keys: keys
          .map((k) => {
            const c = clone(k);
            c.t -= t0;
            return c;
          })
          .sort((a, b) => a.t - b.t),
      });
    }
    set({ keyClipboard: clipboard });
    const total = clipboard.reduce((n, t) => n + t.keys.length, 0);
    s.setStatus(
      'ok',
      `Copied ${total} key${total === 1 ? '' : 's'} from ${picked.size} track${picked.size === 1 ? '' : 's'}`,
    );
    return true;
  },

  // Ctrl/Cmd+V: paste the clipboard block anchored at the snapped playhead,
  // pulled back so the block fits inside the clip (same block-clamp rule as
  // moveKeySnapshot). One untagged history push — a paste is exactly one undo
  // step — then a single set() that upserts every pasted key and selects them.
  pasteKeys: (atTime) => {
    const s = get();
    const clip = s.keyClipboard;
    if (!clip || clip.length === 0) {
      s.setStatus('info', 'Clipboard is empty — copy keyframes first');
      return;
    }
    let span = 0;
    for (const t of clip) for (const k of t.keys) span = Math.max(span, k.t);
    const anchor = Math.max(
      0,
      Math.min(s.snapTime(atTime ?? s.time), s.duration - span),
    );
    s.pushHistory();
    const pastedRefs: { track: TrackId; id: number }[] = [];
    set((st) => {
      let hipsTrack = st.hipsTrack;
      let rotTracks: Partial<Record<string, RotKey[]>> | null = null;
      let exprTracks: Record<string, ExprKey[]> | null = null;
      for (const { track, keys } of clip) {
        if (track === HIPS_TRACK_ID) {
          hipsTrack = mergePastedKeys(hipsTrack, keys as PosKey[], anchor, track, pastedRefs);
        } else if (isExprTrack(track)) {
          const name = exprNameOf(track);
          exprTracks = exprTracks ?? { ...st.exprTracks };
          // Pasting an expression track that no longer exists recreates it.
          exprTracks[name] = mergePastedKeys(
            exprTracks[name] ?? [],
            keys as ExprKey[],
            anchor,
            track,
            pastedRefs,
          );
        } else {
          rotTracks = rotTracks ?? { ...st.rotTracks };
          rotTracks[track] = mergePastedKeys(
            rotTracks[track] ?? [],
            keys as RotKey[],
            anchor,
            track,
            pastedRefs,
          );
        }
      }
      return {
        hipsTrack,
        ...(rotTracks ? { rotTracks } : {}),
        ...(exprTracks ? { exprTracks } : {}),
        selectedKeys: pastedRefs,
        selectedKey: pastedRefs[0] ?? null,
      };
    });
    const total = pastedRefs.length;
    if (total > 0) {
      s.setStatus(
        'ok',
        `Pasted ${total} key${total === 1 ? '' : 's'} at ${anchor.toFixed(2)}s`,
      );
    }
  },

  // Ctrl/Cmd+X: copy, then delete the selection. The delete pushes the (one)
  // history entry; copy pushes none — so a cut is a single undo step.
  cutSelectedKeys: () => {
    if (get().copySelectedKeys()) get().deleteSelectedKey();
  },

  // Ctrl/Cmd+A: every keyframe of every track — rotations, hips, expressions.
  selectAllKeys: () => {
    const s = get();
    const refs: { track: TrackId; id: number }[] = [];
    for (const [bone, keys] of Object.entries(s.rotTracks)) {
      for (const k of keys ?? []) refs.push({ track: bone, id: k.id });
    }
    for (const k of s.hipsTrack) refs.push({ track: HIPS_TRACK_ID, id: k.id });
    for (const [name, keys] of Object.entries(s.exprTracks)) {
      for (const k of keys) refs.push({ track: exprTrackId(name), id: k.id });
    }
    if (refs.length === 0) {
      s.setStatus('info', 'No keyframes to select');
      return;
    }
    set({ selectedKeys: refs, selectedKey: refs[0] });
    s.setStatus('ok', `Selected all ${refs.length} key${refs.length === 1 ? '' : 's'}`);
  },

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
        worn: clone(s.worn),
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
        // Worn donors follow the restored hidden lists (their scenes attach /
        // detach and their own part visibility updates here).
        syncWorn(s.vrm, prev.worn);
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
          worn: clone(s.worn),
          livePose,
        }],
        animName: prev.animName,
        duration: prev.duration,
        rotTracks: prev.rotTracks,
        hipsTrack: prev.hipsTrack,
        exprTracks: prev.exprTracks,
        animRestHipsY: prev.animRestHipsY,
        modelEdits: prev.modelEdits,
        worn: prev.worn,
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
        syncWorn(s.vrm, next.worn);
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
          worn: clone(s.worn),
          livePose,
        }],
        animName: next.animName,
        duration: next.duration,
        rotTracks: next.rotTracks,
        hipsTrack: next.hipsTrack,
        exprTracks: next.exprTracks,
        animRestHipsY: next.animRestHipsY,
        modelEdits: next.modelEdits,
        worn: next.worn,
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

  groundFeet: () => {
    const { vrm, restHipsPos, restFeetY, modelEdits } = get();
    if (!vrm) return null;
    const res = bakeGroundFeet(vrm, get().getAnimData(), restHipsPos, restFeetY, modelEdits.boneScale, modelEdits.bodyShape);
    if (res.sampled === 0) return null;
    get().pushHistory();
    set({ hipsTrack: res.hipsTrack });
    const cm = (m: number) => `${(m * 100).toFixed(1)}cm`;
    const what = res.maxDrop > 0.001 ? `lowered by up to ${cm(res.maxDrop)}` : res.maxLift > 0.001 ? `raised by up to ${cm(res.maxLift)}` : 'already grounded';
    get().setStatus('ok', `Feet planted on the ground — hips ${what}.`);
    return { sampled: res.sampled, maxDrop: res.maxDrop, maxLift: res.maxLift, hipsKeys: res.hipsTrack.length };
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
