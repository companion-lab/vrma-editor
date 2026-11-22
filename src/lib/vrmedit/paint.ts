// Texture painting: a per-material paint session owns a canvas seeded from the
// material's current base texture plus a CanvasTexture applied to every
// instance of that material. Strokes update pixels directly; committing a
// stroke serializes the canvas to a PNG File so the existing edit pipeline
// (MaterialEdit.textureFile → undo history → exportModel) works unchanged.

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

  constructor(vrm: VRM, matName: string) {
    this.vrm = vrm;
    this.matName = matName;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.seedFromLive();
    this.texture = new CanvasTexture(this.canvas);
    // glTF textures are decoded with flipY=false (UV convention) — UVs map
    // straight onto canvas pixels, y down from the top-left origin.
    this.texture.flipY = false;
    this.texture.colorSpace = 'srgb';
    this.texture.name = `${matName}.paint.png`;
    applyLiveTexture(vrm, matName, this.texture);
  }

  /** Copy the material's current base texture image into the canvas. */
  seedFromLive(): void {
    const map = materialsFor(this.vrm, this.matName)[0] as { map?: Texture } | undefined;
    const img = map?.map?.image as TexImage | undefined;
    const iw = img ? ('naturalWidth' in img ? img.naturalWidth : img.width) : 0;
    const ih = img ? ('naturalHeight' in img ? img.naturalHeight : img.height) : 0;
    if (img && iw > 0 && ih > 0) {
      // Downscale only when a texture exceeds the sane canvas cap.
      const scale = Math.min(1, MAX_TEX_SIZE / Math.max(iw, ih));
      this.canvas.width = Math.max(1, Math.round(iw * scale));
      this.canvas.height = Math.max(1, Math.round(ih * scale));
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    } else {
      // Material without a map: start from a blank slate.
      this.canvas.width = 1024;
      this.canvas.height = 1024;
      this.ctx.clearRect(0, 0, 1024, 1024);
    }
  }

  /**
   * Redraw from whatever texture the live material currently holds (after
   * undo/redo/reset). Undo/redo and material resets replace the material's
   * map with a fresh texture, detaching this session's canvas — re-attach it
   * so subsequent strokes render on the model, and record `markFile` as the
   * canvas's source so texture-source identity checks stay coherent.
   */
  resyncFromLive(markFile?: File): void {
    this.seedFromLive();
    applyLiveTexture(this.vrm, this.matName, this.texture);
    if (markFile) setTextureSource(this.texture, markFile);
    else clearTextureSource(this.texture);
    this.texture.needsUpdate = true;
    this.lastCommitFile = markFile;
  }

  beginStroke(): void {
    this.last = null;
  }

  /** Draw from the previous point (if any) to x/y in canvas pixels. */
  strokeTo(x: number, y: number): void {
    const from = this.last;
    this.last = { x, y };
    const b = this.brush;
    const hard = b.hardness >= 0.99;
    if (hard && from) {
      // Uniform-alpha polyline: no overlap darkening between stamps.
      this.ctx.save();
      this.applyStrokeMode();
      this.ctx.strokeStyle = b.color;
      this.ctx.lineWidth = b.size;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo(from.x, from.y);
      this.ctx.lineTo(x, y);
      this.ctx.stroke();
      if (b.mirror) {
        const w = this.canvas.width;
        this.ctx.beginPath();
        this.ctx.moveTo(w - from.x, from.y);
        this.ctx.lineTo(w - x, y);
        this.ctx.stroke();
      }
      this.ctx.restore();
    } else if (hard) {
      this.stampAt(x, y);
    } else {
      // Soft brush: stamp along the segment (no-op spacing when there is no
      // previous point — a single dab).
      const r = Math.max(0.5, b.size / 2);
      const step = Math.max(1, r * 0.4);
      if (from) {
        const dist = Math.hypot(x - from.x, y - from.y);
        const n = Math.max(1, Math.ceil(dist / step));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          this.stampAt(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
        }
      } else {
        this.stampAt(x, y);
      }
    }
    this.texture.needsUpdate = true;
  }

  private applyStrokeMode(): void {
    this.ctx.globalAlpha = this.brush.opacity;
    this.ctx.globalCompositeOperation = this.brush.eraser ? 'destination-out' : 'source-over';
  }

  private stampAt(x: number, y: number): void {
    const b = this.brush;
    const r = Math.max(0.5, b.size / 2);
    this.ctx.save();
    this.applyStrokeMode();
    this.stampCircle(x, y, r);
    if (b.mirror) this.stampCircle(this.canvas.width - x, y, r);
    this.ctx.restore();
  }

  private stampCircle(x: number, y: number, r: number): void {
    const b = this.brush;
    if (b.hardness >= 0.99 || r < 2) {
      this.ctx.fillStyle = b.color;
      this.ctx.beginPath();
      this.ctx.arc(x, y, r, 0, Math.PI * 2);
      this.ctx.fill();
      return;
    }
    const g = this.ctx.createRadialGradient(x, y, r * b.hardness, x, y, r);
    g.addColorStop(0, b.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /**
   * Replace the canvas contents with an image file — the imported image
   * becomes the texture base (canvas resizes to the image, capped). Re-attaches
   * the canvas texture so the model shows it even before the first commit.
   */
  importImageFile(file: File): Promise<void> {
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
          this.ctx.clearRect(0, 0, w, h);
          this.ctx.drawImage(img, 0, 0, w, h);
          this.lastCommitFile = undefined;
          applyLiveTexture(this.vrm, this.matName, this.texture);
          this.texture.needsUpdate = true;
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

  endStroke(): void {
    this.last = null;
  }

  /** Read the current brush color at a canvas pixel (eyedropper). */
  pickColor(x: number, y: number): string | null {
    const d = this.ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    if (d[3] === 0) return null;
    const hex = (v: number) => v.toString(16).padStart(2, '0');
    return `#${hex(d[0])}${hex(d[1])}${hex(d[2])}`;
  }

  /**
   * Serialize the canvas to a PNG File (async, serialized in stroke order so
   * per-stroke history snapshots stay consistent). Extension matters: export
   * infers the image MIME from the file name.
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
 * working for navigate/pan) and click-to-select is suppressed.
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
    el.setPointerCapture(e.pointerId);
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
