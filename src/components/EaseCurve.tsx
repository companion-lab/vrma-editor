// Free-form transition curve editor (Blender-style): a small graph where the
// X axis is the progress toward the next key and the Y axis the eased value.
// The curve is a cubic bezier (0,0)→(1,1) with two draggable handles; handles
// may leave 0..1 vertically for anticipation / follow-through.

import { useEffect, useRef } from 'react';
import { evalCubicBezier, DEFAULT_BEZ, type Bez } from '../lib/vrma/parse';

const W = 208; // css px
const H = 122;
const PAD = 12;
const Y_MIN = -0.6; // drawable value range (overshoot room)
const Y_MAX = 1.6;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

const px = (x: number) => PAD + x * (W - 2 * PAD);
const py = (y: number) => PAD + (1 - (y - Y_MIN) / (Y_MAX - Y_MIN)) * (H - 2 * PAD);

function themeColors(canvas: HTMLCanvasElement) {
  const cs = getComputedStyle(canvas);
  return {
    accent: cs.getPropertyValue('--accent').trim() || '#6ea8fe',
    accent2: cs.getPropertyValue('--accent-2').trim() || '#a78bfa',
    muted: cs.getPropertyValue('--muted').trim() || '#8b90a0',
    border: cs.getPropertyValue('--border').trim() || '#2a2d3a',
  };
}

interface EaseCurveProps {
  bez: Bez | undefined;
  /** Called once per drag stroke (before the first change) for history. */
  strokeStart: () => void;
  /** Live update while a handle is dragged (no history — strokeStart covers it). */
  onChange: (bez: Bez) => void;
}

export function EaseCurve({ bez, strokeStart, onChange }: EaseCurveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<0 | 1 | null>(null);
  const b = bez ?? DEFAULT_BEZ;

  // redraw on every curve change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const c = themeColors(canvas);
    ctx.clearRect(0, 0, W, H);

    // linear reference diagonal + endpoints
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    ctx.lineTo(px(1), py(1));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [ex, ey] of [
      [0, 0],
      [1, 1],
    ] as const) {
      ctx.fillStyle = c.muted;
      ctx.fillRect(px(ex) - 1.5, py(ey) - 1.5, 3, 3);
    }

    // the curve
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const N = 64;
    for (let i = 0; i <= N; i++) {
      const x = i / N;
      const y = evalCubicBezier(b, x);
      if (i === 0) ctx.moveTo(px(x), py(y));
      else ctx.lineTo(px(x), py(y));
    }
    ctx.stroke();

    // handle arms + dots
    ctx.strokeStyle = c.accent2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    ctx.lineTo(px(b[0]), py(b[1]));
    ctx.moveTo(px(1), py(1));
    ctx.lineTo(px(b[2]), py(b[3]));
    ctx.stroke();
    for (const [hx, hy] of [
      [b[0], b[1]],
      [b[2], b[3]],
    ] as const) {
      ctx.beginPath();
      ctx.arc(px(hx), py(hy), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = c.accent2;
      ctx.fill();
      ctx.strokeStyle = c.border;
      ctx.stroke();
    }
  }, [b]);

  // pointer → curve coords (x clamped to 0..1, y to the drawable window)
  const toCurve = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = Math.min(1, Math.max(0, (e.clientX - rect.left - PAD) / (W - 2 * PAD)));
    const vy = Math.min(1, Math.max(0, (e.clientY - rect.top - PAD) / (H - 2 * PAD)));
    return [vx, Y_MIN + (1 - vy) * (Y_MAX - Y_MIN)];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const [mx, my] = toCurve(e);
    const d1 = Math.hypot(px(mx) - px(b[0]), py(my) - py(b[1]));
    const d2 = Math.hypot(px(mx) - px(b[2]), py(my) - py(b[3]));
    dragRef.current = d1 <= d2 ? 0 : 1;
    e.currentTarget.setPointerCapture(e.pointerId);
    strokeStart();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const handle = dragRef.current;
    if (handle == null) return;
    const [mx, my] = toCurve(e);
    const next = [...b] as Bez;
    // keep P1.x <= P2.x so time stays monotonic (unique solve per x)
    if (handle === 0) next[0] = Math.min(mx, b[2]);
    else next[2] = Math.max(mx, b[0]);
    next[handle * 2 + 1] = my;
    onChange(next);
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="ease-curve"
        style={{ width: W, height: H }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="muted small ease-curve-info">
        P1 ({b[0].toFixed(2)}, {b[1].toFixed(2)}) · P2 ({b[2].toFixed(2)}, {b[3].toFixed(2)}) · drag to
        shape; Y outside 0–1 = overshoot
      </div>
    </div>
  );
}
