import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleDot,
  Diamond,
  Eraser,
  KeyRound,
  Maximize2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { HIPS_TRACK_ID, useEditor } from '../store';
import { BONE_ORDER_INDEX, prettyBoneName } from '../lib/humanoid';
import type { PosKey, RotKey } from '../lib/vrma/parse';

const LABEL_W = 150;
const SUMMARY_ID = '__summary__';

const SNAP_OPTIONS: { label: string; value: number }[] = [
  { label: 'Off', value: 0 },
  { label: '1/60s', value: 1 / 60 },
  { label: '1/30s', value: 1 / 30 },
  { label: '1/24s', value: 1 / 24 },
  { label: '1/15s', value: 1 / 15 },
  { label: '0.1s', value: 0.1 },
  { label: '0.5s', value: 0.5 },
  { label: '1s', value: 1 },
];

interface RowInfo {
  track: string;
  label: string;
  isHipsPos: boolean;
  keys: (RotKey | PosKey)[];
  totalRows: number;
  /** Display-only row (the "All tracks" summary): no key interactions. */
  passive?: boolean;
}

// One timeline row. Memoized so per-frame time updates don't re-diff the
// keyframe diamonds. Keys closer together than the minimum pixel gap render
// as a sampled subset — one DOM node per key would freeze the page on
// 700-key mocap tracks, and even 70 keys at 120pps overlap into a blob.
const TrackRow = memo(function TrackRow({
  row,
  pps,
  width,
  selectedId,
  labelSelected,
  onScrubDown,
  onScrubMove,
  onDiamondDown,
  onDiamondMove,
  onDiamondUp,
  onDiamondDelete,
  onLabelClick,
  onLabelContext,
}: {
  row: RowInfo;
  pps: number;
  width: number;
  selectedId: number | null;
  labelSelected: boolean;
  onScrubDown: (e: React.PointerEvent) => void;
  onScrubMove: (e: React.PointerEvent) => void;
  onDiamondDown: (e: React.PointerEvent, track: string, id: number, isHipsPos: boolean) => void;
  onDiamondMove: (e: React.PointerEvent) => void;
  onDiamondUp: () => void;
  onDiamondDelete: (track: string, id: number) => void;
  onLabelClick: (e: React.MouseEvent, track: string) => void;
  onLabelContext: (e: React.MouseEvent, track: string) => void;
}) {
  const { keys, passive } = row;

  // Keep the whole timeline under ~3000 diamond nodes: keys closer than the
  // minimum gap render as a sampled subset (label shows the real count).
  // The gap is at least a diamond's width + air so keys never touch; it only
  // grows past that when many rows would otherwise blow the node budget.
  const minGap = Math.max(13, (row.totalRows * width) / 3000);
  const shown: (RotKey | PosKey)[] = [];
  let lastX = -1e9;
  for (const k of keys) {
    const x = k.t * pps;
    if (x - lastX >= minGap) {
      shown.push(k);
      lastX = x;
    }
  }
  // Always keep the final key visible (clamped in, never past the last shown).
  const lastKey = keys[keys.length - 1];
  if (shown.length > 0 && shown[shown.length - 1] !== lastKey) {
    if (lastKey.t * pps - shown[shown.length - 1].t * pps < minGap / 2) shown[shown.length - 1] = lastKey;
    else shown.push(lastKey);
  }
  const dense = shown.length < keys.length;

  // Span bar: one continuous bar from first to last key so a track reads as a
  // single object even when the diamonds themselves are sampled.
  const x0 = keys[0].t * pps;
  const x1 = lastKey.t * pps;
  const spanW = x1 - x0;

  return (
    <div className={`tl-row${labelSelected && !passive ? ' sel' : ''}`}>
      <div
        className={`tl-label${passive ? '' : ' clickable'}${labelSelected && !passive ? ' selected' : ''}`}
        title={
          passive
            ? `All ${keys.length} keys across every track — click the lane to scrub`
            : dense
              ? `${row.label} — ${keys.length} keys (showing a sampled subset)\nClick: select bone · Ctrl/Cmd+click: multi-select · Shift+click: range · Right-click: remove all its keys`
              : `${row.track}\nClick: select bone · Ctrl/Cmd+click: multi-select · Shift+click: range · Right-click: remove all its keys`
        }
        onClick={passive ? undefined : (e) => onLabelClick(e, row.track)}
        onContextMenu={passive ? undefined : (e) => onLabelContext(e, row.track)}
      >
        {row.label}
        {dense && <span className="dense-count"> · {keys.length}</span>}
      </div>
      <div
        className="tl-track"
        style={{ width }}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="lane" />
        {spanW >= 3 && <div className="span" style={{ left: x0 + 3, width: spanW - 6 }} />}
        {shown.map((k, i) => {
          const selected = !passive && selectedId === k.id;
          const easeClass = k.ease && k.ease !== 'linear' ? ` ease-${k.ease}` : '';
          return (
            <div
              key={passive ? i : k.id}
              className={`diamond${passive ? ' ghost' : ''}${easeClass}${selected ? ' selected' : ''}`}
              style={{ left: k.t * pps }}
              title={`${k.t.toFixed(2)}s${dense ? ` · 1 of ${keys.length} keys` : k.ease && k.ease !== 'linear' ? ` · ${k.ease}` : ''}${passive ? '' : ' — drag to move, right-click to delete'}`}
              onPointerDown={passive ? undefined : (e) => onDiamondDown(e, row.track, k.id, row.isHipsPos)}
              onPointerMove={passive ? undefined : onDiamondMove}
              onPointerUp={passive ? undefined : onDiamondUp}
              onContextMenu={
                passive
                  ? undefined
                  : (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onDiamondDelete(row.track, k.id);
                    }
              }
            />
          );
        })}
      </div>
    </div>
  );
});

export function Timeline() {
  const time = useEditor((s) => s.time);
  const duration = useEditor((s) => s.duration);
  const playing = useEditor((s) => s.playing);
  const loop = useEditor((s) => s.loop);
  const autoKey = useEditor((s) => s.autoKey);
  const snap = useEditor((s) => s.snap);
  const rotTracks = useEditor((s) => s.rotTracks);
  const hipsTrack = useEditor((s) => s.hipsTrack);
  const selectedKey = useEditor((s) => s.selectedKey);
  const selectedBones = useEditor((s) => s.selectedBones);
  const timelineH = useEditor((s) => s.timelineH);
  const st = useEditor;

  // footer resize: drag the top handle up/down, double-click to reset.
  // Window-level listeners (not pointer capture) so the drag keeps working
  // even if the pointer leaves the handle or capture is unavailable.
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = useEditor.getState().timelineH;
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      useEditor.getState().setTimelineH(startH + (startY - ev.clientY));
    };
    const onUp = () => {
      document.body.style.userSelect = prevSelect;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  const [pps, setPpsState] = useState(120);
  const ppsRef = useRef(pps);
  const setPps = (v: number) => {
    ppsRef.current = v;
    setPpsState(v);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const rulerTrackRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<RowInfo[]>(() => {
    const bones = Object.keys(rotTracks)
      .filter((b) => (rotTracks[b]?.length ?? 0) > 0)
      .sort((a, b) => (BONE_ORDER_INDEX[a] ?? 999) - (BONE_ORDER_INDEX[b] ?? 999));
    const totalRows = bones.length + (hipsTrack.length > 0 ? 1 : 0);
    const out: RowInfo[] = bones.map((b) => ({
      track: b,
      label: prettyBoneName(b),
      isHipsPos: false,
      keys: rotTracks[b]!,
      totalRows,
    }));
    if (hipsTrack.length > 0) {
      out.push({ track: HIPS_TRACK_ID, label: 'Hips position', isHipsPos: true, keys: hipsTrack, totalRows });
    }
    return out;
  }, [rotTracks, hipsTrack]);

  // "All tracks" overview: every key time across the animation, merged.
  // Display-only — it shows where motion happens at a glance and scrubs.
  const summaryRow = useMemo<RowInfo | null>(() => {
    const merged: (RotKey | PosKey)[] = [];
    for (const row of rows) merged.push(...row.keys);
    if (merged.length === 0) return null;
    merged.sort((a, b) => a.t - b.t);
    return {
      track: SUMMARY_ID,
      label: 'All tracks',
      isHipsPos: false,
      keys: merged,
      totalRows: rows.length + 1,
      passive: true,
    };
  }, [rows]);

  const contentW = duration * pps;

  // Keep the playhead visible during playback.
  useEffect(() => {
    if (!playing || !scrollRef.current) return;
    const el = scrollRef.current;
    const x = LABEL_W + time * ppsRef.current;
    if (x < el.scrollLeft + LABEL_W || x > el.scrollLeft + el.clientWidth - 60) {
      el.scrollLeft = Math.max(0, x - LABEL_W - el.clientWidth / 3);
    }
  }, [time, playing]);

  // Ctrl/Cmd+wheel zooms around the cursor (the time under the pointer stays
  // under the pointer). Plain wheel/trackpad scrolling stays native.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const tAt = (el.scrollLeft + cx - LABEL_W) / ppsRef.current;
      const next = Math.min(600, Math.max(40, Math.round(ppsRef.current * Math.exp(-e.deltaY * 0.0025))));
      if (next === ppsRef.current) return;
      setPps(next);
      el.scrollLeft = tAt * next + LABEL_W - cx;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const fitToView = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const w = el.clientWidth - LABEL_W - 24;
    if (w <= 0) return;
    setPps(Math.min(600, Math.max(40, Math.round(w / Math.max(duration, 0.1)))));
    el.scrollLeft = 0;
  }, [duration]);

  const timeFromEvent = useCallback((clientX: number): number => {
    const rect = rulerTrackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return (clientX - rect.left) / ppsRef.current;
  }, []);

  // Scrub: pointerdown anywhere on a track background / ruler / playhead cap.
  const onScrubDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const s = st.getState();
    s.setPlaying(false);
    s.setTime(s.snapTime(timeFromEvent(e.clientX)));
  }, [st, timeFromEvent]);
  const onScrubMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const s = st.getState();
    s.setTime(s.snapTime(timeFromEvent(e.clientX)));
  }, [st, timeFromEvent]);

  // Drag a keyframe diamond.
  const dragRef = useRef<{ track: string; id: number } | null>(null);
  const onDiamondDown = useCallback(
    (e: React.PointerEvent, track: string, id: number, isHipsPos: boolean) => {
      e.stopPropagation();
      if (e.button === 2) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { track, id };
      const s = st.getState();
      s.setPlaying(false);
      s.pushHistory();
      s.selectKey(track, id);
      if (!isHipsPos) s.selectBone(track === HIPS_TRACK_ID ? 'hips' : track);
    },
    [st],
  );
  const onDiamondMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      st.getState().moveKey(drag.track, drag.id, timeFromEvent(e.clientX));
    },
    [st, timeFromEvent],
  );
  const onDiamondUp = useCallback(() => {
    dragRef.current = null;
  }, []);
  const onDiamondDelete = useCallback(
    (track: string, id: number) => {
      const s = st.getState();
      s.selectKey(track, id);
      s.deleteSelectedKey();
    },
    [st],
  );

  // Row label = the bone of that track. Click selects the bone (with the
  // same modifiers as the bone tree); right-click removes its whole track.
  const onLabelClick = useCallback(
    (e: React.MouseEvent, track: string) => {
      const bone = track === HIPS_TRACK_ID ? 'hips' : track;
      const s = st.getState();
      if (e.shiftKey) s.selectBoneRange(bone);
      else if (e.ctrlKey || e.metaKey) s.toggleBoneSelection(bone);
      else s.selectBone(bone);
    },
    [st],
  );
  const onLabelContext = useCallback(
    (e: React.MouseEvent, track: string) => {
      e.preventDefault();
      st.getState().deleteBoneKeys(track);
    },
    [st],
  );

  const rulerTicks = useMemo(() => {
    const step = snap > 0 ? snap : pps >= 180 ? 0.1 : pps >= 90 ? 0.25 : pps >= 45 ? 0.5 : 1;
    const labelEvery = step * pps < 48 ? Math.ceil(48 / (step * pps)) : 1;
    const ticks: { t: number; label: string | null }[] = [];
    for (let t = 0, i = 0; t <= duration + 1e-9; t += step, i++) {
      ticks.push({ t, label: i % labelEvery === 0 ? `${t.toFixed(2)}s` : null });
    }
    return ticks;
  }, [duration, pps, snap]);

  // Alternating one-second bands behind the rows — cheap visual anchoring so
  // the eye can read positions without following a tick up from the ruler.
  const secondBands = useMemo(() => {
    const out: number[] = [];
    for (let t = 1; t < duration - 1e-9; t += 2) out.push(t);
    return out;
  }, [duration]);

  const hasKeys = rows.length > 0;

  return (
    <div className="timeline" style={{ height: timelineH }}>
      <div
        className="tl-resize"
        title="Drag to resize · double-click to reset"
        onPointerDown={onResizeDown}
        onDoubleClick={() => st.getState().setTimelineH(218)}
      />
      <div className="transport">
        <button className="btn icon" title="To start" onClick={() => st.getState().setTime(0)}>
          <SkipBack size={15} />
        </button>
        <button
          className={`btn icon accent ${playing ? 'active' : ''}`}
          title="Play / Pause (Space)"
          onClick={() => st.getState().togglePlay()}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button
          className={`btn icon ${loop ? 'active' : ''}`}
          title="Loop"
          onClick={() => st.getState().setLoop(!loop)}
        >
          <Repeat size={15} />
        </button>

        <div className="time-display">
          <span className="cur">{time.toFixed(2)}</span>
          <span className="sep">/</span>
          <input
            className="duration-input"
            type="number"
            min={0.1}
            step={0.1}
            value={Number(duration.toFixed(2))}
            onChange={(e) => st.getState().setDuration(parseFloat(e.target.value) || 0.1)}
            title="Duration (seconds)"
          />
          <span className="unit">s</span>
        </div>

        <div className="vsep" />

        <button className="btn" title="Key selected bone (K)" onClick={() => st.getState().keySelectedBone()}>
          <KeyRound size={14} /> Key
        </button>
        <button className="btn" title="Key the whole pose" onClick={() => st.getState().keyAllBones()}>
          <Diamond size={14} /> Key all
        </button>
        <button
          className={`btn icon ${autoKey ? 'active' : ''}`}
          title="Auto-key: record while manipulating"
          onClick={() => st.getState().setAutoKey(!autoKey)}
        >
          <CircleDot size={15} />
        </button>
        <button
          className="btn icon danger"
          title="Delete selected keyframe (Del)"
          onClick={() => st.getState().deleteSelectedKey()}
        >
          <Trash2 size={15} />
        </button>
        <button
          className="btn icon danger"
          title={
            selectedBones.length > 1
              ? `Remove the entire animation of ${selectedBones.length} selected bones (Shift+Del)`
              : 'Remove the entire animation of the selected bone(s) — Ctrl/Cmd+click bones to multi-select (Shift+Del)'
          }
          onClick={() => st.getState().deleteSelectedBonesKeys()}
        >
          <Eraser size={15} />
        </button>

        <div className="vsep" />

        <label className="snap-label">
          <Magnet />
          <select
            value={snap}
            onChange={(e) => st.getState().setSnap(parseFloat(e.target.value))}
            title="Snap interval"
          >
            {SNAP_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="spacer" />

        <button className="btn icon" title="Fit animation to view" onClick={fitToView}>
          <Maximize2 size={14} />
        </button>
        <button
          className="btn icon"
          title="Zoom out"
          onClick={() => setPps(Math.max(40, Math.round(pps / 1.4)))}
        >
          <ZoomOut size={15} />
        </button>
        <button
          className="btn icon"
          title="Zoom in (Ctrl/Cmd+wheel zooms around the cursor)"
          onClick={() => setPps(Math.min(600, Math.round(pps * 1.4)))}
        >
          <ZoomIn size={15} />
        </button>
      </div>

      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-content" style={{ width: LABEL_W + contentW }}>
          {/* alternating per-second bands */}
          <div className="tl-bands" style={{ left: LABEL_W, width: contentW }}>
            {secondBands.map((t) => (
              <div key={t} className="tl-band" style={{ left: t * pps, width: pps }} />
            ))}
          </div>

          {/* ruler */}
          <div className="tl-row ruler-row">
            <div className="tl-label corner">
              {hasKeys ? `${rows.length} track${rows.length > 1 ? 's' : ''}` : 'Timeline'}
            </div>
            <div
              className="tl-track ruler"
              ref={rulerTrackRef}
              style={{ width: contentW }}
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
            >
              {rulerTicks.map((tick, i) => (
                <div key={i} className={`tick ${tick.label ? 'major' : ''}`} style={{ left: tick.t * pps }}>
                  {tick.label && <span>{tick.label}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* summary + keyframe rows */}
          {summaryRow && (
            <TrackRow
              key={SUMMARY_ID}
              row={summaryRow}
              pps={pps}
              width={contentW}
              selectedId={null}
              labelSelected={false}
              onScrubDown={onScrubDown}
              onScrubMove={onScrubMove}
              onDiamondDown={onDiamondDown}
              onDiamondMove={onDiamondMove}
              onDiamondUp={onDiamondUp}
              onDiamondDelete={onDiamondDelete}
              onLabelClick={onLabelClick}
              onLabelContext={onLabelContext}
            />
          )}
          {rows.map((row) => (
            <TrackRow
              key={row.track}
              row={row}
              pps={pps}
              width={contentW}
              selectedId={selectedKey?.track === row.track ? selectedKey.id : null}
              labelSelected={
                row.track === HIPS_TRACK_ID
                  ? selectedBones.includes('hips')
                  : selectedBones.includes(row.track)
              }
              onScrubDown={onScrubDown}
              onScrubMove={onScrubMove}
              onDiamondDown={onDiamondDown}
              onDiamondMove={onDiamondMove}
              onDiamondUp={onDiamondUp}
              onDiamondDelete={onDiamondDelete}
              onLabelClick={onLabelClick}
              onLabelContext={onLabelContext}
            />
          ))}

          {!hasKeys && (
            <div className="tl-empty">
              No keyframes yet — pose the model and press <kbd>K</kbd> to key the selected bone.
            </div>
          )}

          {/* playhead */}
          <div className="playhead" style={{ left: LABEL_W + time * pps }}>
            <div
              className="playhead-cap"
              title="Drag to scrub"
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onContextMenu={(e) => e.preventDefault()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Magnet() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 15l6-6 6 6" transform="rotate(135 12 12)" />
      <path d="M4 4v6a8 8 0 0 0 16 0V4" />
      <path d="M4 9h5M15 9h5" />
    </svg>
  );
}
