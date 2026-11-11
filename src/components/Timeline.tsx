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
  keySelSet,
  labelSelected,
  onScrubDown,
  onScrubMove,
  onScrubUp,
  onDiamondDown,
  onDiamondMove,
  onDiamondUp,
  onDiamondDelete,
  onLabelClick,
  onLabelContext,
  onSpanDown,
  onSpanMove,
  onSpanUp,
}: {
  row: RowInfo;
  pps: number;
  width: number;
  selectedId: number | null;
  /** Multi-key selection (marquee / column), as "track:id" strings. */
  keySelSet: Set<string>;
  labelSelected: boolean;
  onScrubDown: (e: React.PointerEvent) => void;
  onScrubMove: (e: React.PointerEvent) => void;
  onScrubUp: (e: React.PointerEvent) => void;
  onDiamondDown: (e: React.PointerEvent, track: string, id: number, isHipsPos: boolean) => void;
  onDiamondMove: (e: React.PointerEvent) => void;
  onDiamondUp: () => void;
  onDiamondDelete: (track: string, id: number) => void;
  onLabelClick: (e: React.MouseEvent, track: string) => void;
  onLabelContext: (e: React.MouseEvent, track: string) => void;
  onSpanDown: (e: React.PointerEvent, track: string, isHipsPos: boolean) => void;
  onSpanMove: (e: React.PointerEvent) => void;
  onSpanUp: () => void;
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
            ? `All ${keys.length} keys across every track — click the lane to scrub · Alt+drag: box-select keys`
            : dense
              ? `${row.label} — ${keys.length} keys (showing a sampled subset)\nClick: select bone · Ctrl/Cmd+click: multi-select · Shift+click: range\nDrag the track's bar: move it in time (selected tracks move together)\nAlt+drag the lane: box-select keys in a time range\nRight-click: remove all its keys`
              : `${row.track}\nClick: select bone · Ctrl/Cmd+click: multi-select · Shift+click: range\nDrag the track's bar: move it in time (selected tracks move together)\nAlt+drag the lane: box-select keys in a time range\nRight-click: remove all its keys`
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
        onPointerUp={onScrubUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="lane" />
        {spanW >= 3 && (
          <div
            className={`span${passive ? '' : ' grab'}${!passive && labelSelected ? ' sel' : ''}`}
            style={{ left: x0 + 3, width: spanW - 6 }}
            title={
              passive
                ? undefined
                : `${row.label} — drag the bar to move the whole track in time${
                    labelSelected ? ' (moves every selected track together)' : ''
                  }`
            }
            onPointerDown={passive ? undefined : (e) => onSpanDown(e, row.track, row.isHipsPos)}
            onPointerMove={passive ? undefined : onSpanMove}
            onPointerUp={passive ? undefined : onSpanUp}
            onContextMenu={(e) => e.preventDefault()}
          />
        )}
        {shown.map((k, i) => {
          const selected =
            !passive && (selectedId === k.id || keySelSet.has(`${row.track}:${k.id}`));
          const easeClass = k.ease && k.ease !== 'linear' ? ` ease-${k.ease}` : '';
          return (
            <div
              key={passive ? i : k.id}
              className={`diamond${passive ? ' ghost' : ''}${easeClass}${selected ? ' selected' : ''}`}
              style={{ left: k.t * pps }}
              title={`${k.t.toFixed(2)}s${dense ? ` · 1 of ${keys.length} keys` : k.ease && k.ease !== 'linear' ? ` · ${k.ease}` : ''}${passive ? '' : ' — Alt+click: select all keys at this time · Ctrl/Cmd+click: add to selection · drag to move · right-click: delete'}`}
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
  const selectedKeys = useEditor((s) => s.selectedKeys);
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

  // Keys highlighted by the multi-key selection (marquee / Alt+click column),
  // as "track:id" for O(1) membership in the row render.
  const keySelSet = useMemo(() => new Set(selectedKeys.map((r) => `${r.track}:${r.id}`)), [selectedKeys]);

  // Alt+drag box selection: the time window being swept over the rows.
  const [marquee, setMarquee] = useState<{ t0: number; t1: number } | null>(null);
  const marqueeRef = useRef<{ t0: number; t1: number } | null>(null);

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
  // With Alt held it becomes a box selection: sweep a time window across all
  // tracks and every key inside it gets selected (a plain Alt+click selects
  // the keys around that instant — "all motion at 0.8s").
  const onScrubDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const s = st.getState();
    s.setPlaying(false);
    if (e.altKey) {
      e.preventDefault();
      const t = timeFromEvent(e.clientX);
      marqueeRef.current = { t0: t, t1: t };
      setMarquee({ t0: t, t1: t });
      return;
    }
    s.setTime(s.snapTime(timeFromEvent(e.clientX)));
  }, [st, timeFromEvent]);
  const onScrubMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    if (marqueeRef.current) {
      const band = { t0: marqueeRef.current.t0, t1: timeFromEvent(e.clientX) };
      marqueeRef.current = band;
      setMarquee(band);
      return;
    }
    const s = st.getState();
    s.setTime(s.snapTime(timeFromEvent(e.clientX)));
  }, [st, timeFromEvent]);
  const onScrubUp = useCallback(() => {
    const band = marqueeRef.current;
    if (!band) return;
    marqueeRef.current = null;
    setMarquee(null);
    st.getState().selectKeysInRange(band.t0, band.t1);
  }, [st]);

  // Drag a keyframe diamond. Grab order of precedence:
  //   Alt+click        → select the whole column of keys at that time, and
  //                      continue dragging to move the column.
  //   Ctrl/Cmd+click   → toggle this key in the multi-key selection (no drag).
  //   key in selection → move every selected key together.
  //   track selected   → shift every selected track (bar-drag equivalent).
  //   otherwise        → move just this key.
  const dragRef = useRef<
    | { kind: 'key'; track: string; id: number }
    | { kind: 'keys'; t0: number }
    | { kind: 'tracks'; tracks: string[]; t0: number }
    | null
  >(null);
  const onDiamondDown = useCallback(
    (e: React.PointerEvent, track: string, id: number, isHipsPos: boolean) => {
      e.stopPropagation();
      if (e.button === 2) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const s = st.getState();
      s.setPlaying(false);
      const bone = track === HIPS_TRACK_ID ? 'hips' : track;
      const keys = track === HIPS_TRACK_ID ? s.hipsTrack : s.rotTracks[track];
      const key = keys?.find((k) => k.id === id);
      const t0 = s.snapTime(key?.t ?? s.time);
      const inKeySel = s.selectedKeys.length > 1 && s.selectedKeys.some((r) => r.track === track && r.id === id);
      if (e.altKey && key) {
        // Select all keys at this key's time across every track (windowed on
        // the key's own time so off-grid keys always catch themselves); the
        // drag continues as a column move.
        s.pushHistory();
        s.selectKeysInRange(key.t, key.t);
        dragRef.current = { kind: 'keys', t0 };
      } else if (e.altKey) {
        dragRef.current = null;
      } else if (e.ctrlKey || e.metaKey) {
        s.toggleKeySelection(track, id);
        dragRef.current = null;
      } else if (inKeySel) {
        s.pushHistory();
        dragRef.current = { kind: 'keys', t0 };
      } else {
        const tracks =
          s.selectedBones.length > 1 && s.selectedBones.includes(bone)
            ? s.selectedBones.flatMap((b) => (b === 'hips' ? ['hips', HIPS_TRACK_ID] : [b]))
            : null;
        s.pushHistory();
        s.selectKey(track, id);
        // Grabbing a selected track keeps the multi-selection (so the drag
        // moves every highlighted row); otherwise this bone becomes the
        // selection, like a label click.
        if (!isHipsPos && !tracks) s.selectBone(bone);
        dragRef.current = tracks ? { kind: 'tracks', tracks, t0 } : { kind: 'key', track, id };
      }
    },
    [st],
  );
  const onDiamondMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const s = st.getState();
      if (drag.kind === 'keys') {
        s.moveSelectedKeys(s.snapTime(timeFromEvent(e.clientX)) - drag.t0);
      } else if (drag.kind === 'tracks') {
        s.moveTracks(drag.tracks, s.snapTime(timeFromEvent(e.clientX)) - drag.t0);
      } else {
        s.moveKey(drag.track, drag.id, timeFromEvent(e.clientX));
      }
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

  // Drag a whole track by its span bar (the bar between its first and last
  // key). Grabbing a track that is part of a multi-selection keeps the
  // selection and moves every highlighted track together; otherwise the grab
  // selects the track first (same modifiers as the label click).
  const spanDragRef = useRef<{ anchorT: number; tracks: string[] } | null>(null);
  const onSpanDown = useCallback(
    (e: React.PointerEvent, track: string, isHipsPos: boolean) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const s = st.getState();
      s.setPlaying(false);
      const bone = isHipsPos || track === HIPS_TRACK_ID ? 'hips' : track;
      const inMulti = s.selectedBones.length > 1 && s.selectedBones.includes(bone);
      if (!inMulti) {
        if (e.shiftKey) s.selectBoneRange(bone);
        else if (e.ctrlKey || e.metaKey) s.toggleBoneSelection(bone);
        else s.selectBone(bone);
      }
      // Every highlighted row moves with the drag; the hips bone carries both
      // its rotation track and its position track.
      const tracks = st
        .getState()
        .selectedBones.flatMap((b) => (b === 'hips' ? ['hips', HIPS_TRACK_ID] : [b]));
      spanDragRef.current = { anchorT: timeFromEvent(e.clientX), tracks };
      st.getState().pushHistory();
    },
    [st, timeFromEvent],
  );
  const onSpanMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = spanDragRef.current;
      if (!drag) return;
      const s = st.getState();
      const rawDt = timeFromEvent(e.clientX) - drag.anchorT;
      // Snap the shift (not the key times) so a track keeps its shape and
      // moves in whole snap steps.
      const dt = s.snap > 0 ? Math.round(rawDt / s.snap) * s.snap : rawDt;
      s.moveTracks(drag.tracks, dt);
    },
    [st, timeFromEvent],
  );
  const onSpanUp = useCallback(() => {
    spanDragRef.current = null;
  }, []);

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
              onPointerUp={onScrubUp}
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
              keySelSet={keySelSet}
              labelSelected={false}
              onScrubDown={onScrubDown}
              onScrubMove={onScrubMove}
              onScrubUp={onScrubUp}
              onDiamondDown={onDiamondDown}
              onDiamondMove={onDiamondMove}
              onDiamondUp={onDiamondUp}
              onDiamondDelete={onDiamondDelete}
              onLabelClick={onLabelClick}
              onLabelContext={onLabelContext}
              onSpanDown={onSpanDown}
              onSpanMove={onSpanMove}
              onSpanUp={onSpanUp}
            />
          )}
          {rows.map((row) => (
            <TrackRow
              key={row.track}
              row={row}
              pps={pps}
              width={contentW}
              selectedId={selectedKey?.track === row.track ? selectedKey.id : null}
              keySelSet={keySelSet}
              labelSelected={
                row.track === HIPS_TRACK_ID
                  ? selectedBones.includes('hips')
                  : selectedBones.includes(row.track)
              }
              onScrubDown={onScrubDown}
              onScrubMove={onScrubMove}
              onScrubUp={onScrubUp}
              onDiamondDown={onDiamondDown}
              onDiamondMove={onDiamondMove}
              onDiamondUp={onDiamondUp}
              onDiamondDelete={onDiamondDelete}
              onLabelClick={onLabelClick}
              onLabelContext={onLabelContext}
              onSpanDown={onSpanDown}
              onSpanMove={onSpanMove}
              onSpanUp={onSpanUp}
            />
          ))}

          {!hasKeys && (
            <div className="tl-empty">
              No keyframes yet — pose the model and press <kbd>K</kbd> to key the selected bone.
            </div>
          )}

          {/* Alt+drag box-selection band */}
          {marquee && (
            <div
              className="tl-marquee"
              style={{
                left: LABEL_W + Math.min(marquee.t0, marquee.t1) * pps,
                width: Math.abs(marquee.t1 - marquee.t0) * pps,
              }}
            />
          )}

          {/* playhead */}
          <div className="playhead" style={{ left: LABEL_W + time * pps }}>
            <div
              className="playhead-cap"
              title="Drag to scrub"
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubUp}
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
