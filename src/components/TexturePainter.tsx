// Texture painter: 2D canvas editor over a material's base texture, plus a
// "paint on model" mode that paints by dragging on the viewport. The paint
// session's canvas is the live material map; every stroke commits as a PNG
// File into MaterialEdit.textureFile, so undo history, "Reset edits" and
// "Save model" behave exactly like any other texture replacement.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Eraser, FlipHorizontal2, Minus, Paintbrush, Pipette, Plus, RotateCcw, X } from 'lucide-react';
import { useEditor } from '../store';
import { resetMaterialLive, restoreMaterialTexture, textureSourceMatches } from '../lib/vrmedit/live';
import { getPaintSession, startPaint3D, stopPaint3D } from '../lib/vrmedit/paint';

export function TexturePainter({ matName, onClose }: { matName: string; onClose: () => void }) {
  const vrm = useEditor((s) => s.vrm);
  const texFile = useEditor((s) => s.modelEdits.materials[matName]?.textureFile);
  const session = useMemo(() => (vrm ? getPaintSession(vrm, matName) : null), [vrm, matName]);

  // UI mirrors of the session brush (mutated directly on session.brush).
  const [brushUi, setBrushUi] = useState(() => ({ ...session!.brush }));
  const [picking, setPicking] = useState(false);
  const [mode3D, setMode3D] = useState(false);
  // Zoom: 1 = fit the wrap width; fractions/decimals allowed. Zooming anchors
  // on the cursor (Ctrl+wheel / trackpad pinch) like a normal image previewer.
  const [zoom, setZoom] = useState(1);
  const [zoomPct, setZoomPct] = useState(100);
  const [panning, setPanning] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  // Viewport anchor for the next zoom change (canvas fractions + wrap offsets).
  const anchorRef = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);

  const commitPaintEdit = (file: File) => {
    useEditor.getState().setMaterialEdit(matName, { textureFile: file, textureName: file.name });
  };

  // Mount the session canvas element into the dialog (it leaves the DOM while
  // the dialog is collapsed to the 3D-mode floating bar). Layout-phase so the
  // canvas is attached before the zoom-sizing effect below reads its size.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const canvas = session?.canvas;
    if (!wrap || !canvas || mode3D) return;
    canvas.className = 'painter-canvas';
    wrap.appendChild(canvas);
    return () => {
      if (canvas.parentElement === wrap) wrap.removeChild(canvas);
    };
  }, [session, mode3D]);

  // Keep the session brush in sync with the UI state.
  useEffect(() => {
    if (!session) return;
    Object.assign(session.brush, brushUi);
  }, [session, brushUi]);

  // Zoom sizing: canvas CSS width tracks zoom (1 = fit the wrap width). After
  // a resize, scroll so the anchored canvas point stays under the cursor —
  // the image-previewer feel. Also derives the % display (share of natural
  // pixels).
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const canvas = session?.canvas;
    if (!wrap || !canvas || mode3D) return;
    canvas.style.width = `${zoom * 100}%`;
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
  }, [session, mode3D, zoom]);

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
  // restore path loads it asynchronously, so poll a few frames).
  useEffect(() => {
    if (!session || !vrm) return;
    if (texFile === session.lastCommitFile) return;
    let raf = 0;
    let tries = 0;
    const poll = () => {
      if (textureSourceMatches(vrm, matName, texFile) || ++tries > 240) {
        session.resyncFromLive(texFile);
        return;
      }
      raf = requestAnimationFrame(poll);
    };
    poll();
    return () => cancelAnimationFrame(raf);
  }, [session, vrm, matName, texFile]);

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
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
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
    (e.target as Element).setPointerCapture?.(e.pointerId);
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
    if (picking || !(e.buttons & 1)) return;
    const p = canvasPoint(e);
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
    session.endStroke();
    void session.commit().then(commitPaintEdit).catch((err) => console.error('Paint commit failed:', err));
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

  return (
    <div className={`painter-overlay ${mode3D ? 'painter-mini' : ''}`}>
      <div className="painter-panel">
        <div className="painter-head">
          <Paintbrush size={14} />
          <span className="painter-title" title={matName}>{matName}</span>
          <button
            className={`btn small ${mode3D ? 'active' : ''}`}
            onClick={() => setMode3D(!mode3D)}
            title={mode3D ? 'Return to the 2D texture editor' : 'Paint directly on the model in the viewport'}
          >
            <Paintbrush size={12} /> {mode3D ? 'Back to 2D' : 'Paint on model'}
          </button>
          <button className="btn small icon-only" onClick={onClose} title="Close">
            <X size={12} />
          </button>
        </div>
        {!mode3D && (
          <div className="painter-tools">
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
              title="Eraser"
            >
              <Eraser size={12} />
            </button>
            <button
              className={`btn small ${brushUi.mirror ? 'active' : ''}`}
              onClick={() => setBrush({ mirror: !brushUi.mirror })}
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
        )}
        {!mode3D && (
          <div
            ref={wrapRef}
            className="painter-canvas-wrap"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ cursor: panning ? 'grabbing' : picking ? 'copy' : 'crosshair' }}
          />
        )}
        <div className="painter-foot muted">
          {mode3D
            ? 'Drag on the model to paint · right-drag orbits · middle-drag pans · Esc closes'
            : 'Drag to paint · Ctrl+wheel/pinch zooms · middle-drag pans · Alt-click picks a color · Ctrl/Cmd+Z undoes'}
        </div>
      </div>
    </div>
  );
}
