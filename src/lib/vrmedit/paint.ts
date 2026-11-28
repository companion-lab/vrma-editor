// Texture painting: a per-material paint session owns a Photoshop-style layer
// stack composited into a single canvas that serves as the material's live
// texture. Strokes land on the active layer; committing flattens the stack
// into a PNG File so the existing edit pipeline (MaterialEdit.textureFile →
// undo history → exportModel) works unchanged. The PNG is the source of
// truth — layer structure lives only in the session, and undo/redo/reset
// (which restore a flattened snapshot) collapse the stack to one layer.
// Image ("placed") layers keep a live transform: move/scale/rotate them any
// time with the Move tool; painting or filling on one rasterizes it first.
// Photoshop-style selections (rect/ellipse/lasso/magic wand) live as an alpha
// mask that clips brush/eraser strokes and fills on the active layer.

import {
  CanvasTexture,
  Raycaster,
  Vector2,
  type Texture,
  type Mesh as TMesh,
} from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { getViewport } from '../ai/sceneRef';
import {
  applyLiveTexture,
  clearTextureSource,
  materialsFor,
  setTextureSource,
} from './live';

export interface BrushSettings {
  color: string;
  /** Diameter in texture pixels. */
  size: number;
  /** Stroke opacity 0..1. */
  opacity: number;
  /** 0 = fully soft edge, 1 = hard circle. */
  hardness: number;
  eraser: boolean;
  /** Also stamp the horizontally mirrored position (symmetric painting). */
  mirror: boolean;
}

/** Canvas blend ops for layers ('source-over' = Normal). */
export type LayerBlend =
  | 'source-over' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

/** Live transform of an image layer's content, in canvas pixels. */
export interface ImageTransform {
  img: HTMLImageElement | ImageBitmap;
  w: number;
  h: number;
  /** Center position. */
  x: number;
  y: number;
  /** Share of the image's natural size. */
  scale: number;
  /** Radians. */
  rotation: number;
}

/** A paint layer: full-canvas RGBA content plus compositing params. `image`
 * present ⇒ image layer: its content is drawn from the transform and stays
 * editable (move/scale/rotate) until rasterized or merged. */
export interface PaintLayer {
  id: number;
  name: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blend: LayerBlend;
  image?: ImageTransform;
}

/** The four transformed corner positions of an image layer, in canvas pixels
 * (local order: top-left, top-right, bottom-right, bottom-left). Shared by
 * the transform-box overlay and the corner-resize hit test. */
export function imageLayerCorners(t: ImageTransform): { x: number; y: number }[] {
  const hw = (t.w * t.scale) / 2;
  const hh = (t.h * t.scale) / 2;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const corners: { x: number; y: number }[] = [];
  const locals: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  for (const [lx, ly] of locals) {
    corners.push({ x: t.x + lx * cos - ly * sin, y: t.y + lx * sin + ly * cos });
  }
  return corners;
}

type TexImage = ImageBitmap | HTMLImageElement;

const MAX_TEX_SIZE = 4096;

export class PaintSession {
  readonly vrm: VRM;
  readonly matName: string;
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly brush: BrushSettings = {
    color: '#d6584a',
    size: 24,
    opacity: 1,
    // Hard by default — soft stamps overlap and darken at their rims; the
    // slider opts into airbrush-style accumulation.
    hardness: 1,
    eraser: false,
    mirror: false,
  };
  /** File the canvas was last committed as (identity checked by undo resync). */
  lastCommitFile: File | undefined;
  private ctx: CanvasRenderingContext2D;
  private last: { x: number; y: number } | null = null;
  private commitChain: Promise<unknown> = Promise.resolve();
  private nextLayerId = 1;

  // --- Layers (Photoshop-style) ---
  // Bottom-to-top; every layer canvas matches this.canvas's size. Invariants:
  // at least one layer, activeLayerId always valid, and this.canvas always
  // equals the composite of the visible layers (recomposite() after changes).
  readonly layers: PaintLayer[] = [];
  activeLayerId = 0;
  /** Bumped on every layer/param change (drives the panel + thumbnails). */
  layerVersion = 0;
  /** UI hook — fired whenever the layer stack changes. */
  onLayersChange: (() => void) | null = null;

  // --- Selection (Photoshop-style) ---
  // The selection is an alpha mask (white = selected). `selectionPath` keeps
  // the vector shape for marching ants when there is one (rect/ellipse/lasso);
  // wand and inverted selections are mask-only (ants fall back to edge blink).
  readonly mask: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;
  hasSelection = false;
  selectionPath: Path2D | null = null;
  /** UI hook — fired whenever the selection changes. */
  onSelectionChange: (() => void) | null = null;

  // Scratch layers for the clipped stroke pipeline: strokes render into
  // strokeLayer at full alpha, then composite onto the ACTIVE layer through
  // the selection mask (scratch) on top of the pre-stroke snapshot
  // (baseCanvas). The composite canvas is rebuilt from the stack afterwards.
  private baseCanvas: HTMLCanvasElement;
  private baseCtx: CanvasRenderingContext2D;
  private strokeLayer: HTMLCanvasElement;
  private strokeCtx: CanvasRenderingContext2D;
  private scratch: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;
  private scratchW = 0;
  private scratchH = 0;

  constructor(vrm: VRM, matName: string) {
    this.vrm = vrm;
    this.matName = matName;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.mask = document.createElement('canvas');
    this.maskCtx = this.mask.getContext('2d', { willReadFrequently: true })!;
    this.baseCanvas = document.createElement('canvas');
    this.baseCtx = this.baseCanvas.getContext('2d')!;
    this.strokeLayer = document.createElement('canvas');
    this.strokeCtx = this.strokeLayer.getContext('2d')!;
    this.scratch = document.createElement('canvas');
    this.scratchCtx = this.scratch.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    // glTF textures are decoded with flipY=false (UV convention) — UVs map
    // straight onto canvas pixels, y down from the top-left origin.
    this.texture.flipY = false;
    this.texture.colorSpace = 'srgb';
    this.texture.name = `${matName}.paint.png`;
    this.seedFromLive();
    applyLiveTexture(vrm, matName, this.texture);
  }

  /** Resize the scratch layers when the canvas size changes (content resets). */
  private syncScratchSize(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.scratchW === w && this.scratchH === h) return;
    this.scratchW = w;
    this.scratchH = h;
    for (const c of [this.mask, this.baseCanvas, this.strokeLayer, this.scratch]) {
      c.width = w;
      c.height = h;
    }
    // A canvas resize wipes the mask — the selection no longer matches.
    if (this.hasSelection) {
      this.hasSelection = false;
      this.selectionPath = null;
      this.onSelectionChange?.();
    }
  }

  // --- Layer machinery ---

  private bumpLayers(): void {
    this.layerVersion++;
    this.onLayersChange?.();
  }

  private findLayer(id: number): PaintLayer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  private layerIndex(id: number): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  /** The layer strokes/fills/moves target (always valid). */
  active(): PaintLayer {
    return this.layers.find((l) => l.id === this.activeLayerId) ?? this.layers[this.layers.length - 1]!;
  }

  private makeLayer(name: string, paint?: (ctx: CanvasRenderingContext2D) => void): PaintLayer {
    const canvas = document.createElement('canvas');
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    const ctx = canvas.getContext('2d')!;
    if (paint) paint(ctx);
    return {
      id: this.nextLayerId++,
      name,
      canvas,
      ctx,
      visible: true,
      opacity: 1,
      blend: 'source-over',
    };
  }

  /** Replace the whole stack with a single layer; `paint` seeds its content. */
  private resetLayers(name: string, paint?: (ctx: CanvasRenderingContext2D) => void): PaintLayer {
    const layer = this.makeLayer(name, paint);
    this.layers.length = 0;
    this.layers.push(layer);
    this.activeLayerId = layer.id;
    this.recomposite();
    this.bumpLayers();
    return layer;
  }

  /** Flatten the layer stack into the session canvas (the live texture). */
  private recomposite(): void {
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    for (const l of this.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.blend;
      if (l.image) this.drawImageTransformed(ctx, l.image);
      else ctx.drawImage(l.canvas, 0, 0);
    }
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  /** Draw an image layer's content with its transform (center/rotate/scale). */
  private drawImageTransformed(ctx: CanvasRenderingContext2D, t: ImageTransform): void {
    const dw = t.w * t.scale;
    const dh = t.h * t.scale;
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(t.x, t.y);
    if (t.rotation) ctx.rotate(t.rotation);
    ctx.drawImage(t.img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  // --- Layer operations ---

  /** New empty layer above the active one, which becomes active. */
  addLayer(name?: string): PaintLayer {
    const layer = this.makeLayer(name ?? `Layer ${this.layers.length + 1}`);
    this.layers.splice(this.layerIndex(this.activeLayerId) + 1, 0, layer);
    this.activeLayerId = layer.id;
    this.bumpLayers();
    return layer;
  }

  /** Add a placed image as its own layer above the active one — its transform
   * stays live so the Move tool / sliders can edit it at any time. */
  addImageLayer(img: HTMLImageElement | ImageBitmap, name: string): PaintLayer {
    const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
    const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
    const fit = Math.min((this.canvas.width * 0.8) / w, (this.canvas.height * 0.8) / h, 1);
    const layer = this.makeLayer(name);
    layer.image = {
      img,
      w,
      h,
      x: this.canvas.width / 2,
      y: this.canvas.height / 2,
      scale: Math.max(0.02, fit),
      rotation: 0,
    };
    this.layers.splice(this.layerIndex(this.activeLayerId) + 1, 0, layer);
    this.activeLayerId = layer.id;
    this.recomposite();
    this.bumpLayers();
    return layer;
  }

  /** Copy of the layer (content + params), inserted above it. */
  duplicateLayer(id: number = this.activeLayerId): void {
    const src = this.findLayer(id);
    if (!src) return;
    const copy = this.makeLayer(`${src.name} copy`);
    copy.ctx.drawImage(src.canvas, 0, 0);
    copy.visible = src.visible;
    copy.opacity = src.opacity;
    copy.blend = src.blend;
    if (src.image) copy.image = { ...src.image };
    this.layers.splice(this.layerIndex(id) + 1, 0, copy);
    this.activeLayerId = copy.id;
    this.bumpLayers();
  }

  /** Remove a layer (never the last one); the neighbor becomes active. */
  deleteLayer(id: number = this.activeLayerId): void {
    if (this.layers.length <= 1) return;
    const i = this.layerIndex(id);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.activeLayerId = this.layers[Math.min(i, this.layers.length - 1)]!.id;
    this.recomposite();
    this.bumpLayers();
  }

  /** Reorder: dir +1 moves toward the top of the stack, -1 toward the bottom. */
  moveLayer(id: number, dir: -1 | 1): void {
    const i = this.layerIndex(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.layers.length) return;
    const [l] = this.layers.splice(i, 1);
    this.layers.splice(j, 0, l);
    this.recomposite();
    this.bumpLayers();
  }

  /** Bake a layer (transform included) into the one below it and remove it. */
  mergeDown(id: number = this.activeLayerId): void {
    const i = this.layerIndex(id);
    if (i <= 0) return; // nothing below to merge into
    const upper = this.layers[i]!;
    const lower = this.layers[i - 1]!;
    lower.ctx.save();
    lower.ctx.globalAlpha = upper.opacity;
    lower.ctx.globalCompositeOperation = upper.blend;
    if (upper.image) this.drawImageTransformed(lower.ctx, upper.image);
    else lower.ctx.drawImage(upper.canvas, 0, 0);
    lower.ctx.restore();
    this.layers.splice(i, 1);
    this.activeLayerId = lower.id;
    this.recomposite();
    this.bumpLayers();
  }

  /** Composite all visible layers into a single bottom-to-top replacement. */
  flatten(): void {
    const flat = this.makeLayer('Flattened');
    for (const l of this.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      flat.ctx.save();
      flat.ctx.globalAlpha = l.opacity;
      flat.ctx.globalCompositeOperation = l.blend;
      if (l.image) this.drawImageTransformed(flat.ctx, l.image);
      else flat.ctx.drawImage(l.canvas, 0, 0);
      flat.ctx.restore();
    }
    this.layers.length = 0;
    this.layers.push(flat);
    this.activeLayerId = flat.id;
    this.recomposite();
    this.bumpLayers();
  }

  setActiveLayer(id: number): void {
    if (!this.findLayer(id)) return;
    this.activeLayerId = id;
    this.bumpLayers();
  }

  setLayerVisible(id: number, visible: boolean): void {
    const l = this.findLayer(id);
    if (!l || l.visible === visible) return;
    l.visible = visible;
    this.recomposite();
    this.bumpLayers();
  }

  setLayerOpacity(id: number, opacity: number): void {
    const l = this.findLayer(id);
    if (!l) return;
    l.opacity = Math.min(1, Math.max(0, opacity));
    this.recomposite();
    this.bumpLayers();
  }

  setLayerBlend(id: number, blend: LayerBlend): void {
    const l = this.findLayer(id);
    if (!l || l.blend === blend) return;
    l.blend = blend;
    this.recomposite();
    this.bumpLayers();
  }

  renameLayer(id: number, name: string): void {
    const l = this.findLayer(id);
    if (!l) return;
    l.name = name.trim() || l.name;
    this.bumpLayers();
  }

  /** Update an image layer's transform (scale clamped like the old Place flow). */
  setImageTransform(id: number, patch: Partial<Pick<ImageTransform, 'x' | 'y' | 'scale' | 'rotation'>>): void {
    const l = this.findLayer(id);
    if (!l?.image) return;
    if (patch.scale !== undefined) l.image.scale = Math.min(8, Math.max(0.02, patch.scale));
    if (patch.rotation !== undefined) l.image.rotation = patch.rotation;
    if (patch.x !== undefined) l.image.x = patch.x;
    if (patch.y !== undefined) l.image.y = patch.y;
    this.recomposite();
    this.bumpLayers();
  }

  /** Stamp an image layer's transform into its pixels — Photoshop "rasterize".
   * After this the layer is a normal pixel layer (no longer transformable). */
  rasterizeImageLayer(id: number = this.activeLayerId): void {
    const l = this.findLayer(id);
    if (!l?.image) return;
    this.drawImageTransformed(l.ctx, l.image);
    l.image = undefined;
    this.recomposite();
    this.bumpLayers();
  }

  // --- Move-tool layer drag (move + Photoshop-style corner resize) ---

  private dragLayer: PaintLayer | null = null;
  private dragSnapshot: HTMLCanvasElement | null = null;
  private dragStart: { x: number; y: number } | null = null;
  // Corner-resize context: the opposite corner is the fixed anchor; the
  // grabbed corner aims at the cursor along the initial diagonal (stable
  // under rotation — the factor is projected onto that diagonal).
  private resizeCtx: {
    anchor: { x: number; y: number };
    center: { x: number; y: number };
    scale: number;
    unit: { x: number; y: number };
    length: number;
  } | null = null;

  /** Begin a Move-tool drag on the active layer. Image layers shift their
   * transform (non-destructive); pixel layers translate their content via a
   * per-drag snapshot. */
  beginLayerDrag(): void {
    const l = this.active();
    this.dragLayer = l;
    if (l.image) {
      this.dragStart = { x: l.image.x, y: l.image.y };
    } else {
      const snap = document.createElement('canvas');
      snap.width = this.canvas.width;
      snap.height = this.canvas.height;
      snap.getContext('2d')!.drawImage(l.canvas, 0, 0);
      this.dragSnapshot = snap;
    }
  }

  /** Begin a corner-resize drag on the active image layer (`corner` indexes
   * imageLayerCorners; the opposite corner stays anchored, scale is uniform).
   * Returns false when the active layer is not an image layer. */
  beginLayerResize(corner: number): boolean {
    const l = this.active();
    if (!l?.image) return false;
    const corners = imageLayerCorners(l.image);
    const anchor = corners[(corner + 2) % 4]!;
    const grabbed = corners[corner]!;
    const vx = grabbed.x - anchor.x;
    const vy = grabbed.y - anchor.y;
    const length = Math.hypot(vx, vy) || 1;
    this.resizeCtx = {
      anchor,
      center: { x: l.image.x, y: l.image.y },
      scale: l.image.scale,
      unit: { x: vx / length, y: vy / length },
      length,
    };
    this.dragLayer = l;
    return true;
  }

  /** Shift the dragged layer by (dx, dy) canvas pixels (live, no UI bumps —
   * the panel refreshes once on endLayerDrag). */
  dragLayerBy(dx: number, dy: number): void {
    const l = this.dragLayer;
    if (!l || this.resizeCtx) return;
    if (l.image && this.dragStart) {
      l.image.x = this.dragStart.x + dx;
      l.image.y = this.dragStart.y + dy;
      this.recomposite();
    } else if (this.dragSnapshot) {
      l.ctx.save();
      l.ctx.globalCompositeOperation = 'copy';
      l.ctx.drawImage(this.dragSnapshot, Math.round(dx), Math.round(dy));
      l.ctx.restore();
      this.recomposite();
    }
  }

  /** Aim the dragged corner at (x, y): uniform scale about the fixed anchor
   * (clamped to the scale range, preserving the anchor). Bumps per event so
   * the Scale slider reads out live, Photoshop-style. */
  dragLayerTo(x: number, y: number): void {
    const l = this.dragLayer;
    const r = this.resizeCtx;
    if (!l?.image || !r) return;
    const proj = ((x - r.anchor.x) * r.unit.x + (y - r.anchor.y) * r.unit.y) / r.length;
    const f = Math.min(8 / r.scale, Math.max(0.02 / r.scale, proj));
    l.image.scale = r.scale * f;
    l.image.x = r.anchor.x + (r.center.x - r.anchor.x) * f;
    l.image.y = r.anchor.y + (r.center.y - r.anchor.y) * f;
    this.recomposite();
    this.bumpLayers();
  }

  endLayerDrag(): void {
    const moved = this.dragLayer != null;
    this.dragLayer = null;
    this.dragSnapshot = null;
    this.dragStart = null;
    this.resizeCtx = null;
    if (moved) this.bumpLayers();
  }

  /** Copy the material's current base texture into a fresh single-layer stack. */
  seedFromLive(): void {
    const prevW = this.canvas.width;
    const prevH = this.canvas.height;
    const map = materialsFor(this.vrm, this.matName)[0] as { map?: Texture } | undefined;
    const img = map?.map?.image as TexImage | undefined;
    const iw = img ? ('naturalWidth' in img ? img.naturalWidth : img.width) : 0;
    const ih = img ? ('naturalHeight' in img ? img.naturalHeight : img.height) : 0;
    if (img && iw > 0 && ih > 0) {
      // Downscale only when a texture exceeds the sane canvas cap.
      const scale = Math.min(1, MAX_TEX_SIZE / Math.max(iw, ih));
      const w = Math.max(1, Math.round(iw * scale));
      const h = Math.max(1, Math.round(ih * scale));
      this.canvas.width = w;
      this.canvas.height = h;
      this.resetLayers('Base', (lctx) => lctx.drawImage(img, 0, 0, w, h));
    } else {
      // Material without a map: start from a blank slate.
      this.canvas.width = 1024;
      this.canvas.height = 1024;
      this.resetLayers('Base');
    }
    // Same-size resyncs (undo/redo/reset) keep the selection — it still maps
    // onto the same UV space. Only a size change invalidates it.
    if (this.hasSelection && (this.canvas.width !== prevW || this.canvas.height !== prevH)) {
      this.hasSelection = false;
      this.selectionPath = null;
      this.onSelectionChange?.();
    }
  }

  /**
   * Redraw from whatever texture the live material currently holds (after
   * undo/redo/reset). Undo/redo and material resets replace the material's
   * map with a fresh texture and restore a flattened snapshot, so the layer
   * stack collapses to a single layer carrying it — re-attach the canvas
   * texture so subsequent strokes render on the model, and record `markFile`
   * as the canvas's source so texture-source identity checks stay coherent.
   */
  resyncFromLive(markFile?: File): void {
    this.seedFromLive();
    applyLiveTexture(this.vrm, this.matName, this.texture);
    if (markFile) setTextureSource(this.texture, markFile);
    else clearTextureSource(this.texture);
    this.texture.needsUpdate = true;
    this.lastCommitFile = markFile;
  }

  // --- Selection operations ---

  /** Select a vector shape (antialiased fill into the mask). */
  setSelectionFromPath(path: Path2D): void {
    this.syncScratchSize();
    this.maskCtx.save();
    this.maskCtx.globalCompositeOperation = 'source-over';
    this.maskCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.maskCtx.fillStyle = '#fff';
    this.maskCtx.fill(path);
    this.maskCtx.restore();
    this.hasSelection = true;
    this.selectionPath = path;
    this.onSelectionChange?.();
  }

  /** Select a raster mask (magic wand / inverted selections). */
  setSelectionFromMask(src: HTMLCanvasElement): void {
    this.syncScratchSize();
    this.maskCtx.save();
    this.maskCtx.globalCompositeOperation = 'source-over';
    this.maskCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.maskCtx.drawImage(src, 0, 0);
    this.maskCtx.restore();
    this.hasSelection = true;
    this.selectionPath = null;
    this.onSelectionChange?.();
  }

  selectAll(): void {
    const path = new Path2D();
    path.rect(0, 0, this.canvas.width, this.canvas.height);
    this.setSelectionFromPath(path);
  }

  deselect(): void {
    this.hasSelection = false;
    this.selectionPath = null;
    this.onSelectionChange?.();
  }

  /** Invert the selection (with no selection, invert selects everything). */
  invertSelection(): void {
    if (!this.hasSelection) {
      this.selectAll();
      return;
    }
    this.syncScratchSize();
    const { width: w, height: h } = this.canvas;
    const inv = document.createElement('canvas');
    inv.width = w;
    inv.height = h;
    const ictx = inv.getContext('2d')!;
    ictx.fillStyle = '#fff';
    ictx.fillRect(0, 0, w, h);
    ictx.globalCompositeOperation = 'destination-out';
    ictx.drawImage(this.mask, 0, 0);
    this.setSelectionFromMask(inv);
  }

  /** Draw `color` through the selection mask into the scratch layer. */
  private blitSelectionMask(color = '#fff'): void {
    const s = this.scratchCtx;
    const { width: w, height: h } = this.canvas;
    s.save();
    s.globalCompositeOperation = 'source-over';
    s.clearRect(0, 0, w, h);
    s.fillStyle = color;
    s.fillRect(0, 0, w, h);
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(this.mask, 0, 0);
    s.restore();
  }

  /** Fill the selection (or the whole active layer) — rasterizing an image
   * layer first, Photoshop-style. */
  fillSelection(color: string): void {
    this.syncScratchSize();
    const layer = this.active();
    if (layer.image) this.rasterizeImageLayer(layer.id);
    const { width: w, height: h } = this.canvas;
    const lctx = layer.ctx;
    lctx.save();
    lctx.globalAlpha = 1;
    lctx.globalCompositeOperation = 'source-over';
    if (this.hasSelection) {
      this.blitSelectionMask(color);
      lctx.drawImage(this.scratch, 0, 0);
    } else {
      lctx.fillStyle = color;
      lctx.fillRect(0, 0, w, h);
    }
    lctx.restore();
    this.recomposite();
  }

  /** Erase the selection contents (or the whole active layer). */
  clearSelection(): void {
    this.syncScratchSize();
    const layer = this.active();
    if (layer.image) this.rasterizeImageLayer(layer.id);
    const { width: w, height: h } = this.canvas;
    const lctx = layer.ctx;
    lctx.save();
    lctx.globalAlpha = 1;
    if (this.hasSelection) {
      this.blitSelectionMask();
      lctx.globalCompositeOperation = 'destination-out';
      lctx.drawImage(this.scratch, 0, 0);
    } else {
      lctx.globalCompositeOperation = 'destination-out';
      lctx.fillStyle = '#fff';
      lctx.fillRect(0, 0, w, h);
    }
    lctx.restore();
    this.recomposite();
  }

  /** Contiguous flood-fill selection by per-channel color tolerance (0..255),
   * sampled from the composite so it matches what the user sees. */
  magicWand(x: number, y: number, tolerance: number): void {
    this.syncScratchSize();
    const { width: w, height: h } = this.canvas;
    x = Math.floor(Math.max(0, Math.min(w - 1, x)));
    y = Math.floor(Math.max(0, Math.min(h - 1, y)));
    const d = this.ctx.getImageData(0, 0, w, h).data;
    const seed = (y * w + x) * 4;
    const sr = d[seed], sg = d[seed + 1], sb = d[seed + 2], sa = d[seed + 3];
    const match = (i: number) =>
      Math.abs(d[i] - sr) <= tolerance &&
      Math.abs(d[i + 1] - sg) <= tolerance &&
      Math.abs(d[i + 2] - sb) <= tolerance &&
      Math.abs(d[i + 3] - sa) <= tolerance;
    const visited = new Uint8Array(w * h);
    const out = this.maskCtx.createImageData(w, h);
    const od = out.data;
    // Scanline flood fill from the seed pixel.
    const stack: number[] = [x, y];
    while (stack.length) {
      const py = stack.pop()!;
      const px = stack.pop()!;
      if (visited[py * w + px]) continue;
      let l = px;
      let r = px;
      while (l > 0 && !visited[py * w + l - 1] && match((py * w + l - 1) * 4)) l--;
      while (r < w - 1 && !visited[py * w + r + 1] && match((py * w + r + 1) * 4)) r++;
      for (let i = l; i <= r; i++) {
        const p = py * w + i;
        visited[p] = 1;
        od[p * 4] = 255;
        od[p * 4 + 1] = 255;
        od[p * 4 + 2] = 255;
        od[p * 4 + 3] = 255;
        if (py > 0 && !visited[p - w] && match((p - w) * 4)) stack.push(i, py - 1);
        if (py < h - 1 && !visited[p + w] && match((p + w) * 4)) stack.push(i, py + 1);
      }
    }
    this.maskCtx.putImageData(out, 0, 0);
    this.hasSelection = true;
    this.selectionPath = null;
    this.onSelectionChange?.();
  }

  // --- Brush (clipped by the selection when one is active) ---

  beginStroke(): void {
    this.syncScratchSize();
    const layer = this.active();
    // Painting on a placed image rasterizes it first (Photoshop behavior).
    if (layer.image) this.rasterizeImageLayer(layer.id);
    const { width: w, height: h } = this.canvas;
    this.baseCtx.globalCompositeOperation = 'source-over';
    this.baseCtx.clearRect(0, 0, w, h);
    this.baseCtx.drawImage(layer.canvas, 0, 0);
    this.strokeCtx.clearRect(0, 0, w, h);
    this.last = null;
  }

  /** Draw from the previous point (if any) to x/y in canvas pixels. */
  strokeTo(x: number, y: number): void {
    const from = this.last;
    this.last = { x, y };
    const b = this.brush;
    const ctx = this.strokeCtx;
    const hard = b.hardness >= 0.99;
    const axis = this.canvas.width; // mirror axis
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const drawSeg = (fx: number, fy: number, tx: number, ty: number) => {
      if (hard && from) {
        // Uniform-alpha polyline: no overlap darkening between stamps.
        ctx.strokeStyle = b.color;
        ctx.lineWidth = b.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      } else {
        // Soft brush (or first dab): stamps along the segment.
        const r = Math.max(0.5, b.size / 2);
        const step = Math.max(1, r * 0.4);
        if (from) {
          const dist = Math.hypot(tx - fx, ty - fy);
          const n = Math.max(1, Math.ceil(dist / step));
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            this.drawDab(ctx, fx + (tx - fx) * t, fy + (ty - fy) * t);
          }
        } else {
          this.drawDab(ctx, tx, ty);
        }
      }
    };
    drawSeg(from ? from.x : x, from ? from.y : y, x, y);
    if (b.mirror) drawSeg(from ? axis - from.x : axis - x, from ? from.y : y, axis - x, y);
    ctx.restore();
    this.compositeStroke();
  }

  /**
   * Apply the stroke layer (clipped by the selection) to the ACTIVE layer at
   * brush opacity (or erase it), then flatten the stack into the canvas.
   * Stroke opacity is uniform across the whole stroke, Photoshop-style.
   */
  private compositeStroke(): void {
    const { width: w, height: h } = this.canvas;
    const s = this.scratchCtx;
    s.save();
    s.globalCompositeOperation = 'source-over';
    s.clearRect(0, 0, w, h);
    s.drawImage(this.strokeLayer, 0, 0);
    if (this.hasSelection) {
      s.globalCompositeOperation = 'destination-in';
      s.drawImage(this.mask, 0, 0);
    }
    s.restore();
    const lctx = this.active().ctx;
    lctx.save();
    lctx.globalAlpha = 1;
    lctx.globalCompositeOperation = 'source-over';
    lctx.drawImage(this.baseCanvas, 0, 0);
    lctx.globalAlpha = this.brush.opacity;
    lctx.globalCompositeOperation = this.brush.eraser ? 'destination-out' : 'source-over';
    lctx.drawImage(this.scratch, 0, 0);
    lctx.restore();
    this.recomposite();
  }

  /** One brush dab at full alpha (color alpha ramp for soft brushes). */
  private drawDab(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const b = this.brush;
    const r = Math.max(0.5, b.size / 2);
    if (b.hardness >= 0.99 || r < 2) {
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const g = ctx.createRadialGradient(x, y, r * b.hardness, x, y, r);
    g.addColorStop(0, b.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  endStroke(): void {
    this.last = null;
  }

  /** Read the current brush color at a composite pixel (eyedropper). */
  pickColor(x: number, y: number): string | null {
    const d = this.ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    if (d[3] === 0) return null;
    const hex = (v: number) => v.toString(16).padStart(2, '0');
    return `#${hex(d[0])}${hex(d[1])}${hex(d[2])}`;
  }

  /**
   * Serialize the canvas (the flattened stack) to a PNG File (async,
   * serialized in stroke order so per-stroke history snapshots stay
   * consistent). Extension matters: export infers the image MIME from the
   * file name.
   */
  commit(): Promise<File> {
    const job = this.commitChain.then(() => this.doCommit());
    this.commitChain = job.catch(() => undefined);
    return job;
  }

  private doCommit(): Promise<File> {
    return new Promise<File>((resolve, reject) => {
      this.canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Canvas serialization failed'));
          return;
        }
        const name = `${this.matName}.paint.png`;
        const file = new File([blob], name, { type: 'image/png' });
        setTextureSource(this.texture, file);
        this.lastCommitFile = file;
        this.texture.name = name;
        resolve(file);
      }, 'image/png');
    });
  }

  /**
   * Replace the canvas contents with an image file — the imported image
   * becomes the new base and the layer stack restarts (canvas resizes to the
   * image, capped). Re-attaches the canvas texture so the model shows it even
   * before the first commit. The selection is dropped (the mask geometry no
   * longer matches).
   */
  importImageFile(file: File): Promise<void> {
    this.deselect();
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, MAX_TEX_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          this.canvas.width = w;
          this.canvas.height = h;
          this.resetLayers('Base', (lctx) => lctx.drawImage(img, 0, 0, w, h));
          this.lastCommitFile = undefined;
          applyLiveTexture(this.vrm, this.matName, this.texture);
          URL.revokeObjectURL(url);
          resolve();
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Could not load image: ${file.name}`));
      };
      img.src = url;
    });
  }

  dispose(): void {
    this.texture.dispose();
  }
}

const SESSIONS = new Map<string, PaintSession>();

/** Get (or lazily create) the paint session for a material. Sessions die with the model. */
export function getPaintSession(vrm: VRM, matName: string): PaintSession {
  const existing = SESSIONS.get(matName);
  if (existing && existing.vrm === vrm) return existing;
  disposeAllPaintSessions();
  const session = new PaintSession(vrm, matName);
  SESSIONS.set(matName, session);
  return session;
}

export function disposeAllPaintSessions(): void {
  for (const s of SESSIONS.values()) s.dispose();
  SESSIONS.clear();
  stopPaint3D();
}

// --- Paint directly on the model ---

interface Paint3DHandle {
  dispose(): void;
}

let paint3D: Paint3DHandle | null = null;

/** True while "paint on model" mode is active — Viewport uses this to suppress click-to-select. */
export function paintModeActive(): boolean {
  return paint3D != null;
}

/**
 * Paint the session's material by dragging on the model in the viewport.
 * While active, orbit's LEFT button is freed for painting (middle/right keep
 * working for navigate/pan) and click-to-select is suppressed. Strokes land
 * on the session's active layer, clipped by its selection mask like in the
 * 2D editor.
 */
export function startPaint3D(
  session: PaintSession,
  onStrokeCommit: (file: File) => void,
): void {
  stopPaint3D();
  const vp = getViewport();
  if (!vp) return;
  const el = vp.renderer.domElement;
  const orbit = vp.orbit;

  // Free the left mouse button for painting; keep navigation on other buttons.
  const prevLeft = orbit?.mouseButtons?.LEFT;
  const prevTouchOne = orbit?.touches?.ONE;
  if (orbit) {
    orbit.mouseButtons.LEFT = null;
    orbit.touches.ONE = null;
  }

  const raycaster = new Raycaster();
  const ndc = new Vector2();

  // Meshes using this material (skinned meshes raycast their bind pose — fine
  // for the near-rest poses the editor shows).
  const targetMats = new Set(materialsFor(session.vrm, session.matName));
  const meshes: TMesh[] = [];
  session.vrm.scene.traverse((o) => {
    const mesh = o as TMesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.some((m) => targetMats.has(m))) meshes.push(mesh);
  });

  let painting = false;
  let lastHit: { obj: TMesh; x: number; y: number } | null = null;

  const uvAt = (e: PointerEvent): { obj: TMesh; x: number; y: number } | null => {
    const rect = el.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, vp.camera);
    const hit = raycaster.intersectObjects(meshes, false).find((h) => h.uv);
    if (!hit?.uv) return null;
    return {
      obj: hit.object as TMesh,
      x: hit.uv.x * session.canvas.width,
      y: hit.uv.y * session.canvas.height,
    };
  };

  const drawSegment = (hit: { obj: TMesh; x: number; y: number }): void => {
    // Connect only when consecutive samples land on the same mesh and stay
    // within a plausible UV distance — otherwise it's a new dab (seam/other
    // island), never a line smeared across the atlas.
    if (lastHit && lastHit.obj === hit.obj && Math.hypot(hit.x - lastHit.x, hit.y - lastHit.y) < session.canvas.width * 0.25) {
      session.strokeTo(hit.x, hit.y);
    } else {
      session.beginStroke();
      session.strokeTo(hit.x, hit.y);
    }
    lastHit = hit;
  };

  const onDown = (e: PointerEvent) => {
    if (painting || e.button !== 0 || e.altKey) return;
    const hit = uvAt(e);
    if (!hit) return;
    painting = true;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer id not active (e.g. synthetic events) */
    }
    session.beginStroke();
    lastHit = null;
    drawSegment(hit);
  };
  const onMove = (e: PointerEvent) => {
    if (!painting) return;
    const hit = uvAt(e);
    if (hit) drawSegment(hit);
  };
  const onUp = (e: PointerEvent) => {
    if (!painting) return;
    painting = false;
    session.endStroke();
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    void session.commit().then(onStrokeCommit).catch((err) => console.error('Paint commit failed:', err));
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);

  paint3D = {
    dispose: () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (orbit) {
        orbit.mouseButtons.LEFT = prevLeft;
        orbit.touches.ONE = prevTouchOne;
      }
    },
  };
}

export function stopPaint3D(): void {
  paint3D?.dispose();
  paint3D = null;
}
