// Texture painter: 2D canvas editor over a material's base texture, plus a
// "paint on model" mode that paints by dragging on the viewport. The session
// keeps a Photoshop-style layer stack (see paint.ts); every stroke/layer-op
// commits the flattened composite as a PNG File into MaterialEdit.textureFile,
// so undo history, "Reset edits" and "Save model" behave exactly like any
// other texture replacement.
// Photoshop-style selection tools (rect/ellipse marquee, lasso, magic wand)
// live on the session's mask: they clip brush/eraser strokes in both the 2D
// editor and paint-on-model mode, and support fill/clear/invert.
// Placed images are image layers with a live transform — move/scale/rotate
// them any time with the Move tool; painting on one rasterizes it first.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BoxSelect,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Contrast,
  Copy,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FlipHorizontal2,
  Image as ImageIcon,
  ImagePlus,
  Lasso,
  Maximize,
  Merge,
  Minus,
  Move,
  PaintBucket,
  Paintbrush,
  Pipette,
  Plus,
  RotateCcw,
  SquareStack,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useEditor } from '../store';
import { resetMaterialLive, restoreMaterialTexture, textureSourceMatches } from '../lib/vrmedit/live';
import {
  getPaintSession,
  imageLayerCorners,
  startPaint3D,
  stopPaint3D,
  type ImageTransform,
  type LayerBlend,
  type PaintLayer,
} from '../lib/vrmedit/paint';

type Tool = 'brush' | 'move' | 'rect' | 'ellipse' | 'lasso' | 'wand';

type Marquee =
  | { kind: 'rect' | 'ellipse'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'lasso'; pts: { x: number; y: number }[] };

/** Cursor per transform-box corner (imageLayerCorners order). */
const CORNER_CURSORS = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize'];

const BLEND_MODES: { value: LayerBlend; label: string }[] = [
  { value: 'source-over', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

/** Build the overlay/selection path for an in-progress marquee. */
function marqueeToPath(m: Marquee): Path2D {
  const path = new Path2D();
  if (m.kind === 'lasso') {
    const pts = m.pts;
    if (pts.length === 0) return path;
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    path.closePath();
    return path;
  }
  const x0 = Math.min(m.x0, m.x1);
  const y0 = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0);
  const h = Math.abs(m.y1 - m.y0);
  if (m.kind === 'rect') path.rect(x0, y0, w, h);
  else path.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  return path;
}

/** 34px layer thumbnail: contain-fit of the layer content (image layers draw
 * their transformed bounds). Redrawn when `version` bumps. */
function LayerThumb({ layer, version }: { layer: PaintLayer; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const SIZE = 34;
    c.width = SIZE;
    c.height = SIZE;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, SIZE, SIZE);
    let bw: number;
    let bh: number;
    let draw: (dctx: CanvasRenderingContext2D, w: number, h: number) => void;
    if (layer.image) {
      const t = layer.image;
      const dw = t.w * t.scale;
      const dh = t.h * t.scale;
      const cos = Math.abs(Math.cos(t.rotation));
      const sin = Math.abs(Math.sin(t.rotation));
      bw = dw * cos + dh * sin;
      bh = dw * sin + dh * cos;
      draw = (dctx, w, h) => {
        const s = Math.min(w / bw, h / bh);
        dctx.save();
        dctx.imageSmoothingQuality = 'high';
        dctx.translate(w / 2, h / 2);
        dctx.rotate(t.rotation);
        dctx.scale(s, s);
        dctx.drawImage(t.img, -dw / 2, -dh / 2, dw, dh);
        dctx.restore();
      };
    } else {
      bw = layer.canvas.width;
      bh = layer.canvas.height;
      draw = (dctx, w, h) => {
        const s = Math.min(w / bw, h / bh);
        dctx.imageSmoothingQuality = 'high';
        dctx.drawImage(layer.canvas, (w - bw * s) / 2, (h - bh * s) / 2, bw * s, bh * s);
      };
    }
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    draw(ctx, SIZE, SIZE);
    ctx.restore();
  }, [layer, version]);
  return <canvas ref={ref} className="painter-layer-thumb" />;
}

export function TexturePainter({ matName, onClose }: { matName: string; onClose: () => void }) {
  const vrm = useEditor((s) => s.vrm);
  const texFile = useEditor((s) => s.modelEdits.materials[matName]?.textureFile);
  const session = useMemo(() => (vrm ? getPaintSession(vrm, matName) : null), [vrm, matName]);

  // UI mirrors of the session brush (mutated directly on session.brush).
  const [brushUi, setBrushUi] = useState(() => ({ ...session!.brush }));
  const [picking, setPicking] = useState(false);
  const [mode3D, setMode3D] = useState(false);
  const [tool, setTool] = useState<Tool>('brush');
  const [wandTolerance, setWandTolerance] = useState(32);
  // Bumped whenever the session selection changes (drives button states).
  const [selVersion, setSelVersion] = useState(0);
  // Bumped whenever the session layer stack changes (drives the layers panel
  // + thumbnails; commitPaintEdit also bumps it so strokes show in thumbs).
  const [layerVersion, setLayerVersion] = useState(0);
  // Inline rename: which layer id is being renamed + the draft name.
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  // Corner handle under the cursor with the Move tool (resize cursor feedback).
  const [hoverHandle, setHoverHandle] = useState<number | null>(null);
  // Zoom: 1 = fit the wrap width; fractions/decimals allowed. Zooming anchors
  // on the cursor (Ctrl+wheel / trackpad pinch) like a normal image previewer.
  const [zoom, setZoom] = useState(1);
  const [zoomPct, setZoomPct] = useState(100);
  const [panning, setPanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Bumped after the canvas base changes size (image import) so the zoom
  // display recomputes against the new natural resolution.
  const [texVersion, setTexVersion] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const antsRef = useRef<HTMLCanvasElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const placeInputRef = useRef<HTMLInputElement>(null);
  const zoomRef = useRef(1);
  // Viewport anchor for the next zoom change (canvas fractions + wrap offsets).
  const anchorRef = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  // In-progress rect/ellipse/lasso marquee (read by the ants overlay loop).
  const marqueeRef = useRef<Marquee | null>(null);
  const toolRef = useRef<Tool>('brush');
  const toleranceRef = useRef(32);
  // Active Move-tool drag: 'move' shifts the layer, 'resize' aims a corner
  // handle at the cursor (Photoshop free transform).
  const moveDragRef = useRef<{ mode: 'move' | 'resize'; x: number; y: number } | null>(null);
  // Image transform the overlay draws a corner-handle box for (Move tool +
  // active image layer). Assigned per render, read by the ants rAF loop.
  const overlayImageRef = useRef<ImageTransform | null>(null);
  // Precomputed 1px mask edges for mask-only selections (wand/invert): two
  // tinted copies swapped for a blink instead of per-pixel ants every frame.
  const edgeRef = useRef<{ black: HTMLCanvasElement; white: HTMLCanvasElement } | null>(null);
  // Debounce timer for slider-driven commits (opacity/scale/rotate).
  const commitTimerRef = useRef(0);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  useEffect(() => {
    toleranceRef.current = wandTolerance;
  }, [wandTolerance]);
  useEffect(() => () => window.clearTimeout(commitTimerRef.current), []);

  const commitPaintEdit = (file: File, displayName?: string) => {
    useEditor.getState().setMaterialEdit(matName, { textureFile: file, textureName: displayName ?? file.name });
    // Refresh layer thumbnails after pixel changes land in a commit.
    setLayerVersion((v) => v + 1);
  };

  /** Load an image file into an <img> element (Place flow). */
  const loadImageFile = (file: File) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Could not load image: ${file.name}`));
      };
      img.src = url;
    });

  /** Place an image as its own layer — the Move tool takes over for dragging. */
  const placeImage = async (file: File) => {
    try {
      const img = await loadImageFile(file);
      session!.addImageLayer(img, file.name.replace(/\.[^.]+$/, ''));
      setTool('move');
    } catch (err) {
      console.error(err);
      useEditor.getState().setStatus('error', `Image import failed: ${(err as Error).message}`);
    }
  };

  /** Save the current texture canvas as a PNG download (what you see is what
   * you get — includes every stroke). */
  const downloadTexture = () => {
    session!.canvas.toBlob((blob) => {
      if (!blob) {
        useEditor.getState().setStatus('error', 'Texture download failed');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${matName.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'texture'}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  /** Load an image into the editor as the texture base (Import button / drop). */
  const importImage = async (file: File) => {
    setImporting(true);
    try {
      await session!.importImageFile(file);
      const committed = await session!.commit();
      commitPaintEdit(committed, file.name);
      setTexVersion((v) => v + 1);
    } catch (err) {
      console.error(err);
      useEditor.getState().setStatus('error', `Image import failed: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  // Session → UI: re-render button states when the selection or the layer
  // stack changes.
  useEffect(() => {
    if (!session) return;
    session.onSelectionChange = () => setSelVersion((v) => v + 1);
    session.onLayersChange = () => setLayerVersion((v) => v + 1);
    return () => {
      session.onSelectionChange = null;
      session.onLayersChange = null;
    };
  }, [session]);

  // Mount the session canvas element into the dialog (it leaves the DOM while
  // the dialog is collapsed to the 3D-mode floating bar). Layout-phase so the
  // canvas is attached before the zoom-sizing effect below reads its size.
  useLayoutEffect(() => {
    const holder = holderRef.current;
    const canvas = session?.canvas;
    if (!holder || !canvas || mode3D) return;
    canvas.className = 'painter-canvas';
    holder.appendChild(canvas);
    return () => {
      if (canvas.parentElement === holder) holder.removeChild(canvas);
    };
  }, [session, mode3D]);

  // Keep the session brush in sync with the UI state.
  useEffect(() => {
    if (!session) return;
    Object.assign(session.brush, brushUi);
  }, [session, brushUi]);

  // Zoom sizing: the holder's CSS width tracks zoom (1 = fit the wrap width);
  // the canvas + ants overlay fill it. After a resize, scroll so the anchored
  // canvas point stays under the cursor — the image-previewer feel. Also
  // derives the % display (share of natural pixels).
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const holder = holderRef.current;
    const canvas = session?.canvas;
    if (!wrap || !holder || !canvas || mode3D) return;
    holder.style.width = `${zoom * 100}%`;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    const a = anchorRef.current;
    if (a) {
      anchorRef.current = null;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      wrap.scrollLeft = Math.max(0, Math.min(a.px * cw - a.cx, cw - wrap.clientWidth));
      wrap.scrollTop = Math.max(0, Math.min(a.py * ch - a.cy, ch - wrap.clientHeight));
    }
    setZoomPct(Math.round((canvas.clientWidth / canvas.width) * 100));
  }, [session, mode3D, zoom, texVersion]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Ctrl+wheel / trackpad-pinch zooms around the cursor (needs a native
  // non-passive listener so the browser's own page-zoom can be prevented).
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = session?.canvas;
    if (!wrap || !canvas || mode3D) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; // plain wheel scrolls natively
      e.preventDefault();
      const clamp = (z: number) => Math.min(16, Math.max(0.5, z));
      const wrapRect = wrap.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      anchorRef.current = {
        px: (e.clientX - canvasRect.left) / canvasRect.width,
        py: (e.clientY - canvasRect.top) / canvasRect.height,
        cx: e.clientX - wrapRect.left,
        cy: e.clientY - wrapRect.top,
      };
      // deltaY < 0 (wheel up / pinch out) zooms in.
      setZoom(clamp(zoomRef.current * Math.exp(-e.deltaY * 0.002)));
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [session, mode3D]);

  // Zoom helpers for the toolbar buttons — anchored at the wrap's current
  // center point (so zooming keeps what you're looking at centered).
  const anchorAtWrapCenter = () => {
    const wrap = wrapRef.current;
    const canvas = session?.canvas;
    if (!wrap || !canvas || mode3D) return null;
    anchorRef.current = {
      px: (wrap.scrollLeft + wrap.clientWidth / 2) / canvas.clientWidth,
      py: (wrap.scrollTop + wrap.clientHeight / 2) / canvas.clientHeight,
      cx: wrap.clientWidth / 2,
      cy: wrap.clientHeight / 2,
    };
    return true;
  };
  const zoomBy = (factor: number) => {
    if (!anchorAtWrapCenter()) return;
    setZoom(Math.min(16, Math.max(0.5, zoomRef.current * factor)));
  };
  const zoomToActual = () => {
    const wrap = wrapRef.current;
    if (!wrap || !anchorAtWrapCenter()) return;
    setZoom(Math.min(16, Math.max(0.5, (session?.canvas.width ?? 0) / wrap.clientWidth)));
  };

  // External texture changes (undo/redo/Reset edits) → redraw the canvas from
  // the live material once the restored texture has actually landed (the
  // restore path loads it asynchronously, so poll a few frames). Timer-driven
  // rather than rAF so resyncs still land when the tab is occluded.
  useEffect(() => {
    if (!session || !vrm) return;
    if (texFile === session.lastCommitFile) return;
    let timer = 0;
    let tries = 0;
    const poll = () => {
      if (textureSourceMatches(vrm, matName, texFile) || ++tries > 100) {
        session.resyncFromLive(texFile);
        return;
      }
      timer = window.setTimeout(poll, 50);
    };
    poll();
    return () => window.clearTimeout(timer);
  }, [session, vrm, matName, texFile]);

  // Precompute the selection mask's 1px edge for mask-only selections (magic
  // wand / invert): two tinted copies the overlay blinks between. Vector
  // selections (rect/ellipse/lasso) use real marching ants instead.
  useEffect(() => {
    if (!session) return;
    edgeRef.current = null;
    if (!session.hasSelection || session.selectionPath) return;
    const w = session.canvas.width;
    const h = session.canvas.height;
    if (!w || !h) return;
    const mctx = session.mask.getContext('2d', { willReadFrequently: true })!;
    const data = mctx.getImageData(0, 0, w, h).data;
    const edge = document.createElement('canvas');
    edge.width = w;
    edge.height = h;
    const ectx = edge.getContext('2d')!;
    const eimg = ectx.createImageData(w, h);
    const at = (x: number, y: number) => (y * w + x) * 4 + 3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (data[p * 4 + 3] < 128) continue;
        const up = y > 0 ? data[at(x, y - 1)] : 0;
        const down = y < h - 1 ? data[at(x, y + 1)] : 0;
        const left = x > 0 ? data[at(x - 1, y)] : 0;
        const right = x < w - 1 ? data[at(x + 1, y)] : 0;
        if (up < 128 || down < 128 || left < 128 || right < 128) {
          eimg.data[p * 4] = 255;
          eimg.data[p * 4 + 1] = 255;
          eimg.data[p * 4 + 2] = 255;
          eimg.data[p * 4 + 3] = 255;
        }
      }
    }
    ectx.putImageData(eimg, 0, 0);
    const tint = (color: string) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const cctx = c.getContext('2d')!;
      cctx.drawImage(edge, 0, 0);
      cctx.globalCompositeOperation = 'source-in';
      cctx.fillStyle = color;
      cctx.fillRect(0, 0, w, h);
      return c;
    };
    edgeRef.current = { black: tint('#000'), white: tint('#fff') };
  }, [session, selVersion, texVersion]);

  // Marching-ants overlay: animated dashed outline for vector selections /
  // marquee in progress; blinking edge pixels for mask-only selections.
  useEffect(() => {
    if (!session || mode3D) return;
    let raf = 0;
    const draw = (t: number) => {
      const ants = antsRef.current;
      if (ants) {
        const w = session.canvas.width;
        const h = session.canvas.height;
        if (ants.width !== w || ants.height !== h) {
          ants.width = w;
          ants.height = h;
        }
        const ctx = ants.getContext('2d')!;
        ctx.clearRect(0, 0, w, h);
        // Placed-image transform box (Photoshop free-transform look): rotated
        // outline + corner handles while the Move tool targets an image layer.
        const img = overlayImageRef.current;
        if (img) {
          const corners = imageLayerCorners(img);
          const box = new Path2D();
          corners.forEach((c, i) => (i === 0 ? box.moveTo(c.x, c.y) : box.lineTo(c.x, c.y)));
          box.closePath();
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
          ctx.stroke(box);
          ctx.lineWidth = 1;
          ctx.strokeStyle = '#fff';
          ctx.stroke(box);
          // Handles stay a constant screen size regardless of zoom.
          const disp = ants.width / Math.max(1, ants.getBoundingClientRect().width);
          const hs = Math.max(2, 4 * disp);
          for (const c of corners) {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.rect(c.x - hs, c.y - hs, hs * 2, hs * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        const m = marqueeRef.current;
        const path = m ? marqueeToPath(m) : session.selectionPath;
        if (path) {
          const phase = (t / 50) % 12;
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = '#000';
          ctx.setLineDash([]);
          ctx.stroke(path);
          ctx.strokeStyle = '#fff';
          ctx.setLineDash([5, 5]);
          ctx.lineDashOffset = -phase;
          ctx.stroke(path);
          ctx.setLineDash([]);
        } else if (session.hasSelection && edgeRef.current) {
          ctx.drawImage(Math.floor(t / 300) % 2 ? edgeRef.current.white : edgeRef.current.black, 0, 0);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [session, mode3D]);

  // 3D paint mode lifecycle; also make sure the viewport handlers are removed
  // when the dialog goes away.
  useEffect(() => {
    if (!session || !mode3D) return;
    startPaint3D(session, commitPaintEdit);
    return () => stopPaint3D();
  }, [session, mode3D]);
  useEffect(() => () => stopPaint3D(), []);

  // Escape closes (paint modes are cleaned up by the effects above).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!session || !vrm) return null;

  const activeLayer = session.layers.find((l) => l.id === session.activeLayerId)
    ?? session.layers[session.layers.length - 1]!;
  // The overlay reads this per frame (transform box only while the Move tool
  // targets an image layer).
  overlayImageRef.current = tool === 'move' ? activeLayer.image ?? null : null;

  /** Pixel-mutating ops commit like strokes (undoable). */
  const commitPixels = () => {
    void session.commit().then(commitPaintEdit).catch((err) => console.error('Paint commit failed:', err));
  };
  /** Debounced commit for slider-driven changes (opacity/scale/rotate). */
  const commitSoon = () => {
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = window.setTimeout(() => {
      void session.commit().then(commitPaintEdit).catch((err) => console.error('Paint commit failed:', err));
    }, 350);
  };

  const canvasPoint = (e: React.PointerEvent) => {
    const canvas = session.canvas;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Middle-drag pans the view (image-previewer style); painting is left-drag.
    if (e.button === 1) {
      e.preventDefault(); // stop the browser's middle-click autoscroll
      panRef.current = { x: e.clientX, y: e.clientY };
      setPanning(true);
      try {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* pointer id not active */
      }
      return;
    }
    const p = canvasPoint(e);
    if (picking || e.altKey) {
      const c = session.pickColor(p.x, p.y);
      if (c) setBrushUi((b) => ({ ...b, color: c }));
      setPicking(false);
      return;
    }
    if (e.button !== 0) return;
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* pointer id not active */
    }
    const activeTool = toolRef.current;
    if (activeTool === 'move') {
      // A corner handle hit starts a Photoshop-style resize (opposite corner
      // anchors, uniform scale); anything else moves the layer.
      let mode: 'move' | 'resize' = 'move';
      if (activeLayer.image) {
        const canvas = session.canvas;
        const rect = canvas.getBoundingClientRect();
        const thr = (10 / rect.width) * canvas.width;
        const idx = imageLayerCorners(activeLayer.image)
          .findIndex((c) => Math.hypot(p.x - c.x, p.y - c.y) <= thr);
        if (idx >= 0 && session.beginLayerResize(idx)) mode = 'resize';
      }
      moveDragRef.current = { mode, x: p.x, y: p.y };
      if (mode === 'move') session.beginLayerDrag();
      return;
    }
    if (activeTool !== 'brush') {
      if (activeTool === 'wand') {
        session.magicWand(p.x, p.y, toleranceRef.current);
      } else if (activeTool === 'lasso') {
        marqueeRef.current = { kind: 'lasso', pts: [p] };
      } else {
        marqueeRef.current = { kind: activeTool, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
      return;
    }
    session.beginStroke();
    session.strokeTo(p.x, p.y);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (panRef.current) {
      const wrap = wrapRef.current;
      if (wrap) {
        wrap.scrollLeft += panRef.current.x - e.clientX;
        wrap.scrollTop += panRef.current.y - e.clientY;
      }
      panRef.current = { x: e.clientX, y: e.clientY };
      return;
    }
    const p = canvasPoint(e);
    const m = marqueeRef.current;
    if (m) {
      if (m.kind === 'lasso') {
        const lastPt = m.pts[m.pts.length - 1];
        if (Math.hypot(p.x - lastPt.x, p.y - lastPt.y) >= 2) m.pts.push(p);
      } else {
        m.x1 = p.x;
        m.y1 = p.y;
      }
      return;
    }
    if (moveDragRef.current) {
      const d = moveDragRef.current;
      if (d.mode === 'resize') {
        // Aim the grabbed corner at the cursor (session computes the scale).
        session.dragLayerTo(p.x, p.y);
      } else {
        // Pass the offset from the drag's start point (dragLayerBy positions
        // the layer absolutely against its pre-drag snapshot / origin).
        session.dragLayerBy(p.x - d.x, p.y - d.y);
      }
      return;
    }
    if (picking || !(e.buttons & 1)) return;
    // Hover feedback: resize cursor when a corner handle is under the pointer.
    if (toolRef.current === 'move' && activeLayer.image) {
      const canvas = session.canvas;
      const rect = canvas.getBoundingClientRect();
      const thr = (10 / rect.width) * canvas.width;
      const idx = imageLayerCorners(activeLayer.image)
        .findIndex((c) => Math.hypot(p.x - c.x, p.y - c.y) <= thr);
      setHoverHandle(idx >= 0 ? idx : null);
    }
    session.strokeTo(p.x, p.y);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (panRef.current) {
      panRef.current = null;
      setPanning(false);
      if ((e.currentTarget as Element).hasPointerCapture?.(e.pointerId)) {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      }
      return;
    }
    if (moveDragRef.current) {
      moveDragRef.current = null;
      session.endLayerDrag();
      commitPixels();
      return;
    }
    const m = marqueeRef.current;
    if (m) {
      marqueeRef.current = null;
      if (m.kind === 'lasso') {
        // A click (too few points) deselects, like dragging an empty marquee.
        if (m.pts.length >= 3) session.setSelectionFromPath(marqueeToPath(m));
        else session.deselect();
      } else {
        const w = Math.abs(m.x1 - m.x0);
        const h = Math.abs(m.y1 - m.y0);
        if (w < 2 && h < 2) session.deselect();
        else session.setSelectionFromPath(marqueeToPath(m));
      }
      return;
    }
    session.endStroke();
    commitPixels();
  };

  const fillSelection = () => {
    session.fillSelection(brushUi.color);
    commitPixels();
  };
  const clearSelection = () => {
    session.clearSelection();
    commitPixels();
  };

  const resetTexture = () => {
    // Revert only this material's texture (undoable). If the edit record has
    // nothing else worth keeping, drop it entirely so the "edited" badge
    // doesn't linger on an empty edit.
    const st = useEditor.getState();
    const edit = st.modelEdits.materials[matName];
    const hasOtherEdits = edit != null && ['color', 'opacity', 'alphaMode', 'emissive', 'doubleSided'].some((k) => (edit as Record<string, unknown>)[k] !== undefined);
    if (hasOtherEdits) {
      st.setMaterialEdit(matName, { textureFile: undefined, textureName: undefined });
      restoreMaterialTexture(vrm, matName);
    } else {
      st.resetMaterialEdit(matName);
      resetMaterialLive(vrm, matName);
    }
    session.resyncFromLive();
  };

  const setBrush = (patch: Partial<typeof brushUi>) => setBrushUi((b) => ({ ...b, ...patch }));
  const painting = tool === 'brush';
  const hasSelection = session.hasSelection;
  const topLayerId = session.layers[session.layers.length - 1].id;
  const bottomLayerId = session.layers[0].id;

  const toolBtn = (t: Tool, title: string, icon: React.ReactNode) => (
    <button
      className={`btn small ${tool === t ? 'active' : ''}`}
      onClick={() => { marqueeRef.current = null; setHoverHandle(null); setTool(t); }}
      title={title}
    >
      {icon}
    </button>
  );

  return (
    <div className={`painter-overlay ${mode3D ? 'painter-mini' : ''}`}>
      <div className="painter-panel">
        <div className="painter-head">
          <Paintbrush size={14} />
          <span className="painter-title" title={matName}>{matName}</span>
          <button
            className={`btn small ${mode3D ? 'active' : ''}`}
            onClick={() => { marqueeRef.current = null; setMode3D(!mode3D); }}
            title={mode3D ? 'Return to the 2D texture editor' : 'Paint directly on the model in the viewport'}
          >
            <Paintbrush size={12} /> {mode3D ? 'Back to 2D' : 'Paint on model'}
          </button>
          <button className="btn small icon-only" onClick={onClose} title="Close">
            <X size={12} />
          </button>
        </div>
        {!mode3D && (
          <>
            {activeLayer.image && (
              <div className="painter-tools painter-place-row">
                <span className="painter-place-label">Image layer — drag to move · drag a corner handle to resize</span>
                <label className="painter-tool" title="Placement scale (share of the image's natural size)">
                  <span>Scale</span>
                  <input
                    type="range" min={2} max={400} step={1}
                    value={Math.round(activeLayer.image.scale * 100)}
                    onChange={(e) => {
                      session.setImageTransform(activeLayer.id, { scale: parseInt(e.target.value, 10) / 100 });
                      commitSoon();
                    }}
                  />
                  <span className="painter-tool-val">{Math.round(activeLayer.image.scale * 100)}%</span>
                </label>
                <label className="painter-tool" title="Rotation (degrees)">
                  <span>Rotate</span>
                  <input
                    type="range" min={-180} max={180} step={1}
                    value={Math.round((activeLayer.image.rotation * 180) / Math.PI)}
                    onChange={(e) => {
                      session.setImageTransform(activeLayer.id, { rotation: (parseInt(e.target.value, 10) * Math.PI) / 180 });
                      commitSoon();
                    }}
                  />
                  <span className="painter-tool-val">{Math.round((activeLayer.image.rotation * 180) / Math.PI)}°</span>
                </label>
                <button
                  className="btn small"
                  onClick={() => { session.rasterizeImageLayer(); commitPixels(); }}
                  title="Stamp the image into this layer's pixels (locks its transform)"
                >
                  Rasterize
                </button>
              </div>
            )}
            <div className="painter-tools">
              <div className="painter-tool" title="Tools">
                {toolBtn('brush', 'Brush (drag to paint)', <Paintbrush size={12} />)}
                {toolBtn('move', 'Move — drag the active layer · drag a placed image\'s corner to resize', <Move size={12} />)}
                {toolBtn('rect', 'Rectangular selection (drag; click to deselect)', <BoxSelect size={12} />)}
                {toolBtn('ellipse', 'Elliptical selection (drag; click to deselect)', <CircleDashed size={12} />)}
                {toolBtn('lasso', 'Lasso selection (drag a freehand shape)', <Lasso size={12} />)}
                {toolBtn('wand', 'Magic wand (click a color region)', <Wand2 size={12} />)}
              </div>
              <label className="painter-tool" title="Brush color">
                <input
                  type="color"
                  value={brushUi.color}
                  onChange={(e) => setBrush({ color: e.target.value })}
                />
              </label>
              <label className="painter-tool" title="Brush size (texture pixels)">
                <span>Size</span>
                <input
                  type="range" min={1} max={256} step={1}
                  value={brushUi.size}
                  onChange={(e) => setBrush({ size: parseInt(e.target.value, 10) })}
                />
                <span className="painter-tool-val">{brushUi.size}</span>
              </label>
              <label className="painter-tool" title="Stroke opacity">
                <span>Opacity</span>
                <input
                  type="range" min={0.05} max={1} step={0.05}
                  value={brushUi.opacity}
                  onChange={(e) => setBrush({ opacity: parseFloat(e.target.value) })}
                />
                <span className="painter-tool-val">{Math.round(brushUi.opacity * 100)}%</span>
              </label>
              <label className="painter-tool" title="Edge hardness (left = airbrush, right = hard circle)">
                <span>Hardness</span>
                <input
                  type="range" min={0.05} max={1} step={0.05}
                  value={brushUi.hardness}
                  onChange={(e) => setBrush({ hardness: parseFloat(e.target.value) })}
                />
              </label>
              <button
                className={`btn small ${brushUi.eraser ? 'active' : ''}`}
                onClick={() => setBrush({ eraser: !brushUi.eraser })}
                disabled={!painting}
                title="Eraser"
              >
                <Eraser size={12} />
              </button>
              <button
                className={`btn small ${brushUi.mirror ? 'active' : ''}`}
                onClick={() => setBrush({ mirror: !brushUi.mirror })}
                disabled={!painting}
                title="Mirror strokes horizontally (symmetric painting)"
              >
                <FlipHorizontal2 size={12} />
              </button>
              <button
                className={`btn small ${picking ? 'active' : ''}`}
                onClick={() => setPicking(!picking)}
                title="Eyedropper (or Alt-click the canvas)"
              >
                <Pipette size={12} />
              </button>
              {tool === 'wand' && (
                <label className="painter-tool" title="Magic wand tolerance (per-channel color distance)">
                  <span>Tolerance</span>
                  <input
                    type="range" min={0} max={255} step={1}
                    value={wandTolerance}
                    onChange={(e) => setWandTolerance(parseInt(e.target.value, 10))}
                  />
                  <span className="painter-tool-val">{wandTolerance}</span>
                </label>
              )}
            </div>
            <div className="painter-tools">
              <button
                className="btn small"
                onClick={fillSelection}
                disabled={!hasSelection}
                title="Fill the selection with the brush color (on the active layer)"
              >
                <PaintBucket size={12} /> Fill
              </button>
              <button
                className="btn small"
                onClick={clearSelection}
                disabled={!hasSelection}
                title="Erase the selection contents (on the active layer)"
              >
                <Trash2 size={12} /> Clear
              </button>
              <button
                className="btn small"
                onClick={() => session.invertSelection()}
                title="Invert the selection"
              >
                <Contrast size={12} /> Invert
              </button>
              <button
                className="btn small"
                onClick={() => session.selectAll()}
                title="Select the whole texture"
              >
                <Maximize size={12} /> All
              </button>
              <button
                className="btn small"
                onClick={() => session.deselect()}
                disabled={!hasSelection}
                title="Deselect"
              >
                <X size={12} /> Deselect
              </button>
              <span className="painter-tool-val" style={{ minWidth: 0 }}>
                {hasSelection ? 'selection active' : 'no selection'}
              </span>
              <span style={{ flex: 1 }} />
              <button
                className={`btn small ${importing ? 'active' : ''}`}
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
                title="Import an image as the texture base — replaces the layer stack (or drop one onto the canvas)"
              >
                <ImagePlus size={12} /> {importing ? 'Importing…' : 'Import'}
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void importImage(f);
                }}
              />
              <button
                className="btn small"
                onClick={() => placeInputRef.current?.click()}
                title="Place an image on its own layer — move/scale/rotate it any time with the Move tool"
              >
                <ImageIcon size={12} /> Place
              </button>
              <input
                ref={placeInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void placeImage(f);
                }}
              />
              <button
                className="btn small"
                onClick={downloadTexture}
                title="Download the current texture as a PNG"
              >
                <Download size={12} /> Download
              </button>
              <button className="btn small" onClick={resetTexture} title="Restore this material's original texture (keeps color edits)">
                <RotateCcw size={12} /> Reset texture
              </button>
              <div className="painter-tool" title="Zoom — Ctrl+wheel or pinch on the canvas, middle-drag to pan">
                <button className="btn small" onClick={() => zoomBy(1 / 1.25)} title="Zoom out">
                  <Minus size={12} />
                </button>
                <button
                  className="btn small painter-zoom-pct"
                  onClick={zoomToActual}
                  title="Actual size (100%) — click to reset to 1:1"
                >
                  {zoomPct}%
                </button>
                <button className="btn small" onClick={() => zoomBy(1.25)} title="Zoom in">
                  <Plus size={12} />
                </button>
                <button className="btn small" onClick={() => { anchorRef.current = { px: 0, py: 0, cx: 0, cy: 0 }; setZoom(1); }} title="Fit to view">
                  Fit
                </button>
              </div>
            </div>
            <div className="painter-body">
              <div
                ref={wrapRef}
                className={`painter-canvas-wrap ${dragOver ? 'drag-over' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = [...(e.dataTransfer.files ?? [])].find((f) => f.type.startsWith('image/'));
                  if (file) void importImage(file);
                }}
                style={{
                  cursor: panning
                    ? 'grabbing'
                    : picking
                      ? 'copy'
                      : hoverHandle != null
                        ? CORNER_CURSORS[hoverHandle]
                        : tool === 'move'
                          ? 'move'
                          : 'crosshair',
                }}
              >
                <div ref={holderRef} className="painter-canvas-holder">
                  <canvas ref={antsRef} className="painter-ants" />
                </div>
              </div>
              <div className="painter-layers">
                <div className="painter-layer-list">
                  {[...session.layers].reverse().map((l) => (
                    <div
                      key={l.id}
                      className={`painter-layer-row ${l.id === session.activeLayerId ? 'active' : ''} ${l.visible ? '' : 'hidden'}`}
                      onClick={() => session.setActiveLayer(l.id)}
                    >
                      <button
                        className="btn small icon-only"
                        onClick={(e) => {
                          e.stopPropagation();
                          session.setLayerVisible(l.id, !l.visible);
                          commitPixels();
                        }}
                        title={l.visible ? 'Hide layer' : 'Show layer'}
                      >
                        {l.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                      </button>
                      <LayerThumb layer={l} version={layerVersion} />
                      {renamingId === l.id ? (
                        <input
                          className="painter-layer-name-input"
                          autoFocus
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={() => { session.renameLayer(l.id, nameDraft); setRenamingId(null); }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              session.renameLayer(l.id, nameDraft);
                              setRenamingId(null);
                            } else if (e.key === 'Escape') {
                              e.stopPropagation(); // cancel the rename, not the dialog
                              setRenamingId(null);
                            }
                          }}
                        />
                      ) : (
                        <span
                          className="painter-layer-name"
                          title={`${l.name} — double-click to rename`}
                          onDoubleClick={() => { setRenamingId(l.id); setNameDraft(l.name); }}
                        >
                          {l.name}
                        </span>
                      )}
                      {l.image && <ImageIcon size={11} className="painter-layer-badge" />}
                    </div>
                  ))}
                </div>
                <div className="painter-layer-ctl">
                  <span>Opacity</span>
                  <input
                    type="range" min={0} max={100} step={1}
                    value={Math.round(activeLayer.opacity * 100)}
                    onChange={(e) => {
                      session.setLayerOpacity(activeLayer.id, parseInt(e.target.value, 10) / 100);
                      commitSoon();
                    }}
                  />
                  <span className="painter-tool-val">{Math.round(activeLayer.opacity * 100)}%</span>
                </div>
                <div className="painter-layer-ctl">
                  <span>Blend</span>
                  <select
                    className="painter-layer-blend"
                    value={activeLayer.blend}
                    onChange={(e) => {
                      session.setLayerBlend(activeLayer.id, e.target.value as LayerBlend);
                      commitPixels();
                    }}
                  >
                    {BLEND_MODES.map((b) => (
                      <option key={b.value} value={b.value}>{b.label}</option>
                    ))}
                  </select>
                </div>
                <div className="painter-layer-actions">
                  <button
                    className="btn small"
                    onClick={() => session.addLayer()}
                    title="New layer (strokes go to the active layer)"
                  >
                    <Plus size={12} />
                  </button>
                  <button
                    className="btn small"
                    onClick={() => session.duplicateLayer()}
                    title="Duplicate the active layer"
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    className="btn small"
                    onClick={() => { session.moveLayer(activeLayer.id, 1); commitPixels(); }}
                    disabled={activeLayer.id === topLayerId}
                    title="Move the layer up in the stack"
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    className="btn small"
                    onClick={() => { session.moveLayer(activeLayer.id, -1); commitPixels(); }}
                    disabled={activeLayer.id === bottomLayerId}
                    title="Move the layer down in the stack"
                  >
                    <ChevronDown size={12} />
                  </button>
                  <button
                    className="btn small"
                    onClick={() => { session.mergeDown(); commitPixels(); }}
                    disabled={activeLayer.id === bottomLayerId}
                    title="Merge the active layer down into the one below"
                  >
                    <Merge size={12} />
                  </button>
                  <button
                    className="btn small"
                    onClick={() => { session.flatten(); commitPixels(); }}
                    title="Flatten all layers into one"
                  >
                    <SquareStack size={12} />
                  </button>
                  <button
                    className="btn small"
                    onClick={() => { session.deleteLayer(); commitPixels(); }}
                    disabled={session.layers.length <= 1}
                    title="Delete the active layer"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
        <div className="painter-foot muted">
          {mode3D
            ? 'Drag on the model to paint · right-drag orbits · middle-drag pans · Esc closes'
            : 'Drag to paint (on the active layer) · Move tool drags the layer / placed image (corners resize) · selections clip painting (2D + on-model) · Ctrl+wheel/pinch zooms · middle-drag pans · Alt-click picks a color'}
        </div>
      </div>
    </div>
  );
}
