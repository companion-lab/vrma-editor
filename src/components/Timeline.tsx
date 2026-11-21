import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CircleDot,
  ClipboardPaste,
  Copy,
  Diamond,
  Eraser,
  Footprints,
  KeyRound,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Scissors,
  SkipBack,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { HIPS_TRACK_ID, exprNameOf, exprTrackId, isExprTrack, useEditor } from '../store';
import { BONE_ORDER_INDEX, prettyBoneName } from '../lib/humanoid';
import type { ExprKey, PosKey, RotKey } from '../lib/vrma/parse';

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
  isExpr: boolean;
  keys: (RotKey | PosKey | ExprKey)[];
  totalRows: number;
  /** Display-only row (the "All tracks" summary): no key interactions. */
  passive?: boolean;
}

type MenuItem = { label: string; run?: () => void; disabled?: boolean; danger?: boolean } | 'sep';

/** Key times captured when a group drag starts — every pointer move sets
 *  absolute snapshot.t + delta, so the block follows the cursor 1:1. */
type KeySnapshot = { track: string; id: number; t: number };

/** The keys of one track id (bone, hips sentinel or expr:<name>). */
function trackKeys(
  s: {
    rotTracks: Partial<Record<string, (RotKey | PosKey)[]>>;
    hipsTrack: PosKey[];
    exprTracks: Record<string, ExprKey[]>;
  },
  track: string,
): (RotKey | PosKey | ExprKey)[] | undefined {
  return track === HIPS_TRACK_ID
    ? s.hipsTrack
    : isExprTrack(track)
      ? s.exprTracks[exprNameOf(track)]
      : s.rotTracks[track];
}

function snapshotSelectedKeys(s: {
  selectedKeys: { track: string; id: number }[];
  rotTracks: Partial<Record<string, (RotKey | PosKey)[]>>;
  hipsTrack: PosKey[];
  exprTracks: Record<string, ExprKey[]>;
}): KeySnapshot[] {
  return s.selectedKeys.map((r) => {
    const k = trackKeys(s, r.track)?.find((q) => q.id === r.id);
    return { track: r.track, id: r.id, t: k?.t ?? 0 };
  });
}

function snapshotTracks(
  s: {
    rotTracks: Partial<Record<string, (RotKey | PosKey)[]>>;
    hipsTrack: PosKey[];
    exprTracks: Record<string, ExprKey[]>;
  },
  tracks: string[],
): KeySnapshot[] {
  return tracks.flatMap((tr) =>
    (trackKeys(s, tr) ?? []).map((k) => ({
      track: tr,
      id: k.id,
      t: k.t,
    })),
  );
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
  onDiamondMenu,
  onLabelClick,
  onLabelMenu,
  onLaneMenu,
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
  onDiamondMenu: (e: React.MouseEvent, track: string, id: number) => void;
  onLabelClick: (e: React.MouseEvent, track: string) => void;
  onLabelMenu: (e: React.MouseEvent, track: string) => void;
  onLaneMenu: (e: React.MouseEvent, track: string) => void;
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
  const shown: (RotKey | PosKey | ExprKey)[] = [];
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
    <div className={`tl-row${labelSelected && !passive ? ' sel' : ''}`} data-row={row.track}>
      <div
        className={`tl-label${passive ? '' : ' clickable'}${labelSelected && !passive ? ' selected' : ''}`}
        title={
          passive
            ? `All ${keys.length} keys across every track — click the lane to scrub · Alt+drag: select a time band across all tracks`
            : row.isExpr
              ? dense
                ? `Expression "${row.label}" — ${keys.length} keys (showing a sampled subset)\nDrag on the lane: box-select keys · Alt+drag the bar: move the whole track in time\nRight-click the lane or a key: menu (select / copy / paste / remove)`
                : `Expression "${row.label}"\nDrag on the lane: box-select keys (like files in Explorer) · Ctrl/Cmd+click keys: multi-select\nAlt+drag the bar: move the whole track in time\nRight-click the lane or a key: menu (select / copy / paste / remove)`
              : dense
                ? `${row.label} — ${keys.length} keys (showing a sampled subset)\nClick: select bone · Ctrl/Cmd+click: multi-select · Shift+click: range\nDrag on the lane: box-select keys (like files in Explorer) · Ctrl/Cmd+drag: add to selection · Alt+drag: time band across all tracks\nAlt+drag the track's bar: move the whole track in time (selected tracks move together)\nRight-click the lane or a key: menu (select / copy / paste / remove) · Esc: clear key selection`
                : `${row.track}\nClick: select bone · Ctrl/Cmd+click: multi-select · Shift+click: range\nDrag on the lane: box-select keys (like files in Explorer) · Ctrl/Cmd+drag: add to selection · Alt+drag: time band across all tracks\nAlt+drag the track's bar: move the whole track in time (selected tracks move together)\nRight-click the lane or a key: menu (select / copy / paste / remove) · Esc: clear key selection`
        }
        onClick={passive ? undefined : (e) => onLabelClick(e, row.track)}
        onContextMenu={passive ? undefined : (e) => onLabelMenu(e, row.track)}
      >
        {row.label}
        {dense && <span className="dense-count"> · {keys.length}</span>}
      </div>
      <div
        className="tl-track"
        style={{ width }}
        data-lane={passive ? undefined : row.track}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
        onContextMenu={passive ? (e) => e.preventDefault() : (e) => onLaneMenu(e, row.track)}
      >
        <div className="lane" />
        {spanW >= 3 && (
          <div
            className={`span${passive ? '' : ' grab'}${!passive && labelSelected ? ' sel' : ''}`}
            style={{ left: x0 + 3, width: spanW - 6 }}
            title={
              passive
                ? undefined
                : `${row.label} — Alt+drag the bar to move the whole track in time${
                    labelSelected ? ' (moves every selected track together)' : ''
                  }`
            }
            onPointerDown={passive ? undefined : (e) => onSpanDown(e, row.track, row.isHipsPos)}
            onPointerMove={passive ? undefined : onSpanMove}
            onPointerUp={passive ? undefined : onSpanUp}
            onContextMenu={passive ? (e) => e.preventDefault() : (e) => onLaneMenu(e, row.track)}
          />
        )}
        {shown.map((k, i) => {
          const selected =
            !passive && (selectedId === k.id || keySelSet.has(`${row.track}:${k.id}`));
          const easeClass = k.ease && k.ease !== 'linear' ? ` ease-${k.ease}` : '';
          const weight = row.isExpr && 'w' in k ? ` · w=${(k as ExprKey).w.toFixed(2)}` : '';
          return (
            <div
              key={passive ? i : k.id}
              className={`diamond${passive ? ' ghost' : ''}${easeClass}${selected ? ' selected' : ''}`}
              style={{ left: k.t * pps }}
              title={`${k.t.toFixed(2)}s${weight}${dense ? ` · 1 of ${keys.length} keys` : !row.isExpr && k.ease && k.ease !== 'linear' ? ` · ${k.ease}` : ''}${passive ? '' : ' — Alt+click: select all keys at this time · Ctrl/Cmd+click: add to selection · drag to move · right-click: menu'}`}
              onPointerDown={passive ? undefined : (e) => onDiamondDown(e, row.track, k.id, row.isHipsPos)}
              onPointerMove={passive ? undefined : onDiamondMove}
              onPointerUp={passive ? undefined : onDiamondUp}
              onContextMenu={
                passive
                  ? undefined
                  : (e) => onDiamondMenu(e, row.track, k.id)
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
  const exprTracks = useEditor((s) => s.exprTracks);
  const selectedKey = useEditor((s) => s.selectedKey);
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const selectedBones = useEditor((s) => s.selectedBones);
  const hasClipboard = useEditor((s) => s.keyClipboard != null);
  const clipCount = useEditor((s) => s.keyClipboard?.reduce((n, t) => n + t.keys.length, 0) ?? 0);
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
  const contentRef = useRef<HTMLDivElement>(null);
  const rulerTrackRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<RowInfo[]>(() => {
    const bones = Object.keys(rotTracks)
      .filter((b) => (rotTracks[b]?.length ?? 0) > 0)
      .sort((a, b) => (BONE_ORDER_INDEX[a] ?? 999) - (BONE_ORDER_INDEX[b] ?? 999));
    const exprNames = Object.keys(exprTracks)
      .filter((n) => (exprTracks[n]?.length ?? 0) > 0)
      .sort((a, b) => a.localeCompare(b));
    const totalRows = bones.length + (hipsTrack.length > 0 ? 1 : 0) + exprNames.length;
    const out: RowInfo[] = bones.map((b) => ({
      track: b,
      label: prettyBoneName(b),
      isHipsPos: false,
      isExpr: false,
      keys: rotTracks[b]!,
      totalRows,
    }));
    if (hipsTrack.length > 0) {
      out.push({ track: HIPS_TRACK_ID, label: 'Hips position', isHipsPos: true, isExpr: false, keys: hipsTrack, totalRows });
    }
    // Expression rows after the bones, alphabetical (no bone order to follow).
    for (const n of exprNames) {
      out.push({ track: exprTrackId(n), label: n, isHipsPos: false, isExpr: true, keys: exprTracks[n]!, totalRows });
    }
    return out;
  }, [rotTracks, hipsTrack, exprTracks]);

  // "All tracks" overview: every key time across the animation, merged.
  // Display-only — it shows where motion happens at a glance and scrubs.
  const summaryRow = useMemo<RowInfo | null>(() => {
    const merged: (RotKey | PosKey | ExprKey)[] = [];
    for (const row of rows) merged.push(...row.keys);
    if (merged.length === 0) return null;
    merged.sort((a, b) => a.t - b.t);
    return {
      track: SUMMARY_ID,
      label: 'All tracks',
      isHipsPos: false,
      isExpr: false,
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
  //
  // On a keyframe lane, a press is ambiguous until the pointer moves:
  //   click (no drag)   → scrub the playhead there + clear the key selection
  //                       (like clicking empty space in a file explorer)
  //   drag              → Explorer-style 2D box selection: a rectangle whose
  //                       rows × time span select every key diamond it crosses
  //   Ctrl/Cmd + drag   → the box adds to the existing selection
  //   Alt + drag        → time-band box across ALL tracks (column select)
  // The ruler and the playhead cap keep pure scrubbing.
  interface LaneGeom {
    track: string;
    top: number;
    bottom: number;
    left: number;
  }
  const dragSelectRef = useRef<{
    lanes: LaneGeom[];
    x0: number;
    y0: number;
    additive: boolean;
    active: boolean;
  } | null>(null);
  const [rectSelect, setRectSelect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const onScrubDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Some environments (synthetic events, stale pointer ids) throw — the
        // drag then works window-wide via the button-held move guard instead.
      }
      const s = st.getState();
      s.setPlaying(false);
      if (e.altKey) {
        e.preventDefault();
        const t = timeFromEvent(e.clientX);
        marqueeRef.current = { t0: t, t1: t };
        setMarquee({ t0: t, t1: t });
        return;
      }
      if ((e.currentTarget as HTMLElement).dataset.lane != null) {
        // Potential drag selection: capture every lane's geometry up front so
        // the rectangle can sweep across rows while the pointer stays
        // captured by the lane it started on.
        e.preventDefault();
        const lanes: LaneGeom[] = [];
        scrollRef.current?.querySelectorAll<HTMLElement>('.tl-track[data-lane]').forEach((el) => {
          const r = el.getBoundingClientRect();
          lanes.push({ track: el.dataset.lane!, top: r.top, bottom: r.bottom, left: r.left });
        });
        dragSelectRef.current = {
          lanes,
          x0: e.clientX,
          y0: e.clientY,
          additive: e.ctrlKey || e.metaKey,
          active: false,
        };
        return;
      }
      s.setTime(s.snapTime(timeFromEvent(e.clientX)));
    },
    [st, timeFromEvent],
  );
  const onScrubMove = useCallback(
    (e: React.PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      if (!el.hasPointerCapture?.(e.pointerId)) {
        // Capture unavailable (synthetic events, capture failure): an active
        // drag still follows button-held moves, hovers stay ignored.
        if (!dragSelectRef.current && !marqueeRef.current) return;
        if (!(e.buttons & 1)) return;
      }
      const g = dragSelectRef.current;
      if (g) {
        if (!g.active) {
          if (Math.abs(e.clientX - g.x0) < 4 && Math.abs(e.clientY - g.y0) < 4) return;
          g.active = true;
        }
        const s = st.getState();
        const minX = Math.min(g.x0, e.clientX);
        const maxX = Math.max(g.x0, e.clientX);
        const minY = Math.min(g.y0, e.clientY);
        const maxY = Math.max(g.y0, e.clientY);
        const refs: { track: string; id: number }[] = [];
        for (const lane of g.lanes) {
          if (lane.bottom < minY || lane.top > maxY) continue;
          const keys = trackKeys(s, lane.track);
          for (const k of keys ?? []) {
            const kx = lane.left + k.t * ppsRef.current;
            if (kx >= minX - 5 && kx <= maxX + 5) refs.push({ track: lane.track, id: k.id });
          }
        }
        s.selectKeys(refs, g.additive ? 'add' : 'replace');
        const content = contentRef.current;
        if (content) {
          const cr = content.getBoundingClientRect();
          setRectSelect({
            left: minX - cr.left,
            top: minY - cr.top,
            width: maxX - minX,
            height: maxY - minY,
          });
        }
        return;
      }
      if (marqueeRef.current) {
        const band = { t0: marqueeRef.current.t0, t1: timeFromEvent(e.clientX) };
        marqueeRef.current = band;
        setMarquee(band);
        return;
      }
      const s = st.getState();
      s.setTime(s.snapTime(timeFromEvent(e.clientX)));
    },
    [st, timeFromEvent],
  );
  const onScrubUp = useCallback(
    (e: React.PointerEvent) => {
      const g = dragSelectRef.current;
      if (g) {
        dragSelectRef.current = null;
        setRectSelect(null);
        if (!g.active) {
          // Plain click on empty lane: scrub. The key selection survives —
          // one mis-click must not wipe a selection built across many rows
          // (Esc clears it deliberately).
          const s = st.getState();
          s.setTime(s.snapTime(timeFromEvent(e.clientX)));
          return;
        }
        // Recompute the selection from the up position: pointer streams can
        // coalesce away the final move, and the selection must match the
        // rectangle the user actually released on.
        const s = st.getState();
        const minX = Math.min(g.x0, e.clientX);
        const maxX = Math.max(g.x0, e.clientX);
        const minY = Math.min(g.y0, e.clientY);
        const maxY = Math.max(g.y0, e.clientY);
        const refs: { track: string; id: number }[] = [];
        for (const lane of g.lanes) {
          if (lane.bottom < minY || lane.top > maxY) continue;
          const keys = trackKeys(s, lane.track);
          for (const k of keys ?? []) {
            const kx = lane.left + k.t * ppsRef.current;
            if (kx >= minX - 5 && kx <= maxX + 5) refs.push({ track: lane.track, id: k.id });
          }
        }
        s.selectKeys(refs, g.additive ? 'add' : 'replace');
        return;
      }
      const band = marqueeRef.current;
      if (!band) return;
      marqueeRef.current = null;
      setMarquee(null);
      st.getState().selectKeysInRange(band.t0, band.t1);
    },
    [st, timeFromEvent],
  );

  // Drag a keyframe diamond. Grab order of precedence:
  //   Alt+click        → select the whole column of keys at that time, and
  //                      continue dragging to move the column.
  //   Ctrl/Cmd+click   → toggle this key in the multi-key selection (no drag).
  //   key in selection → move every selected key together.
  //   track selected   → shift every selected track (bar-drag equivalent).
  //   otherwise        → move just this key.
  const dragRef = useRef<
    | { kind: 'key'; track: string; id: number }
    | { kind: 'group'; snapshot: KeySnapshot[]; t0: number }
    | null
  >(null);
  const onDiamondDown = useCallback(
    (e: React.PointerEvent, track: string, id: number, isHipsPos: boolean) => {
      e.stopPropagation();
      if (e.button === 2) return;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // synthetic / stale pointer id — the drag still works via button-held moves
      }
      const s = st.getState();
      s.setPlaying(false);
      const bone = isExprTrack(track) ? null : track === HIPS_TRACK_ID ? 'hips' : track;
      const keys = trackKeys(s, track);
      const key = keys?.find((k) => k.id === id);
      const t0 = s.snapTime(key?.t ?? s.time);
      const inKeySel = s.selectedKeys.length > 1 && s.selectedKeys.some((r) => r.track === track && r.id === id);
      if (e.altKey && key) {
        // Select all keys at this key's time across every track (windowed on
        // the key's own time so off-grid keys always catch themselves); the
        // drag continues as a column move.
        s.pushHistory();
        s.selectKeysInRange(key.t, key.t);
        dragRef.current = { kind: 'group', snapshot: snapshotSelectedKeys(st.getState()), t0 };
      } else if (e.altKey) {
        dragRef.current = null;
      } else if (e.ctrlKey || e.metaKey) {
        s.toggleKeySelection(track, id);
        dragRef.current = null;
      } else if (inKeySel) {
        s.pushHistory();
        dragRef.current = { kind: 'group', snapshot: snapshotSelectedKeys(s), t0 };
      } else {
        const tracks =
          bone != null && s.selectedBones.length > 1 && s.selectedBones.includes(bone)
            ? s.selectedBones.flatMap((b) => (b === 'hips' ? ['hips', HIPS_TRACK_ID] : [b]))
            : null;
        s.pushHistory();
        s.selectKey(track, id);
        // Grabbing a selected track keeps the multi-selection (so the drag
        // moves every highlighted row); otherwise this bone becomes the
        // selection, like a label click. Expression tracks have no bone.
        if (bone != null && !isHipsPos && !tracks) s.selectBone(bone);
        dragRef.current = tracks
          ? { kind: 'group', snapshot: snapshotTracks(s, tracks), t0 }
          : { kind: 'key', track, id };
      }
    },
    [st],
  );
  const onDiamondMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const s = st.getState();
      if (drag.kind === 'group') {
        s.moveKeySnapshot(drag.snapshot, s.snapTime(timeFromEvent(e.clientX)) - drag.t0);
      } else {
        s.moveKey(drag.track, drag.id, timeFromEvent(e.clientX));
      }
    },
    [st, timeFromEvent],
  );
  const onDiamondUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Right-click opens a context menu instead of destroying data: a right-click
  // on a key used to delete it on the spot, and one on a row label wiped the
  // whole track's animation. Now every destructive action lives behind an
  // explicit menu item, and copy/paste/select become discoverable.
  interface MenuState {
    x: number;
    y: number;
    kind: 'key' | 'label' | 'lane' | 'ruler';
    track: string;
    /** Key id for 'key' menus. */
    id?: number;
    /** Time under the cursor (lane / ruler / key menus). */
    time: number;
  }
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenuAt = useCallback((e: React.MouseEvent, m: Omit<MenuState, 'x' | 'y'>) => {
    setMenu({ ...m, x: e.clientX, y: e.clientY });
  }, []);

  // Key menu: right-clicking an unselected key selects it first, so the menu
  // operates on it; a key inside the multi-selection keeps that selection.
  const onDiamondMenu = useCallback(
    (e: React.MouseEvent, track: string, id: number) => {
      e.preventDefault();
      e.stopPropagation();
      const s = st.getState();
      const key = trackKeys(s, track)?.find((k) => k.id === id);
      const inKeySel = s.selectedKeys.some((r) => r.track === track && r.id === id);
      if (!inKeySel) s.selectKey(track, id);
      openMenuAt(e, { kind: 'key', track, id, time: key?.t ?? s.time });
    },
    [st, openMenuAt],
  );

  const onLabelMenu = useCallback(
    (e: React.MouseEvent, track: string) => {
      e.preventDefault();
      openMenuAt(e, { kind: 'label', track, time: 0 });
    },
    [openMenuAt],
  );

  const onLaneMenu = useCallback(
    (e: React.MouseEvent, track: string) => {
      e.preventDefault();
      openMenuAt(e, { kind: 'lane', track, time: Math.max(0, timeFromEvent(e.clientX)) });
    },
    [openMenuAt, timeFromEvent],
  );

  const onRulerMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      openMenuAt(e, { kind: 'ruler', track: '', time: Math.max(0, timeFromEvent(e.clientX)) });
    },
    [openMenuAt, timeFromEvent],
  );

  // Close the menu on any click outside it, Escape, scroll, or resize.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Swallow this Escape so the app-wide handler doesn't also clear the
        // key selection — Esc with a menu open dismisses just the menu.
        e.stopPropagation();
        setMenu(null);
      }
    };
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    const scroller = scrollRef.current;
    scroller?.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      scroller?.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // Keep the menu on screen once measured.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    let { x, y } = menu;
    if (r.right > window.innerWidth - 8) x = window.innerWidth - 8 - r.width;
    if (r.bottom > window.innerHeight - 8) y = window.innerHeight - 8 - r.height;
    if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y });
  });

  // Row label = the bone of that track. Click selects the bone (with the
  // same modifiers as the bone tree); right-click opens the track menu
  // (select / copy / paste / remove — nothing destructive happens on the
  // click itself). Expression tracks have no bone — clicking their label
  // does nothing.
  const onLabelClick = useCallback(
    (e: React.MouseEvent, track: string) => {
      if (isExprTrack(track)) return;
      const bone = track === HIPS_TRACK_ID ? 'hips' : track;
      const s = st.getState();
      if (e.shiftKey) s.selectBoneRange(bone);
      else if (e.ctrlKey || e.metaKey) s.toggleBoneSelection(bone);
      else s.selectBone(bone);
    },
    [st],
  );

  // Drag a whole track by its span bar (the bar between its first and last
  // key) — Alt+drag, so the default lane drag stays a key box-selection.
  // Grabbing a track that is part of a multi-selection keeps the selection
  // and moves every highlighted track together; otherwise the grab selects
  // the track first (same modifiers as the label click).
  const spanDragRef = useRef<{ anchorT: number; snapshot: KeySnapshot[] } | null>(null);
  const onSpanDown = useCallback(
    (e: React.PointerEvent, track: string, isHipsPos: boolean) => {
      if (e.button !== 0) return;
      if (!e.altKey) return; // no modifier: the lane's box-selection handles it
      e.stopPropagation();
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // synthetic / stale pointer id
      }
      const s = st.getState();
      s.setPlaying(false);
      // Expression tracks have no bone selection — the drag moves just them.
      if (isExprTrack(track)) {
        spanDragRef.current = {
          anchorT: timeFromEvent(e.clientX),
          snapshot: snapshotTracks(s, [track]),
        };
        st.getState().pushHistory();
        return;
      }
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
      spanDragRef.current = {
        anchorT: timeFromEvent(e.clientX),
        snapshot: snapshotTracks(st.getState(), tracks),
      };
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
      s.moveKeySnapshot(drag.snapshot, dt);
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

  // Menu contents, resolved from what was right-clicked. Labels and counts
  // reflect the state at open time; actions re-read the store when clicked.
  const menuTrack = menu && menu.kind !== 'ruler' ? rows.find((r) => r.track === menu.track) : undefined;
  const menuLabel = menuTrack?.label ?? menu?.track ?? '';
  const keysWord = (n: number) => `key${n === 1 ? '' : 's'}`;
  const menuSelCount = selectedKeys.length > 0 ? selectedKeys.length : selectedKey ? 1 : 0;
  const menuItems: MenuItem[] = [];
  if (menu?.kind === 'key') {
    const n = Math.max(1, menuSelCount);
    menuItems.push(
      { label: `Copy ${n} ${keysWord(n)}`, run: () => st.getState().copySelectedKeys() },
      { label: `Cut ${n} ${keysWord(n)}`, run: () => st.getState().cutSelectedKeys() },
      clipCount > 0
        ? {
            label: `Paste ${clipCount} ${keysWord(clipCount)} at ${menu.time.toFixed(2)}s`,
            run: () => st.getState().pasteKeys(menu.time),
          }
        : { label: 'Paste — clipboard is empty', disabled: true },
      'sep',
      {
        label: `Select all keys at ${menu.time.toFixed(2)}s`,
        run: () => st.getState().selectKeysInRange(menu.time, menu.time),
      },
      'sep',
      { label: `Delete ${n} ${keysWord(n)}`, danger: true, run: () => st.getState().deleteSelectedKey() },
    );
  } else if (menu && (menu.kind === 'label' || menu.kind === 'lane')) {
    const n = menuTrack?.keys.length ?? 0;
    menuItems.push(
      { label: `Select all keys of ${menuLabel}`, run: () => st.getState().selectTrackKeys(menu.track) },
      { label: `Copy all keys of ${menuLabel}`, run: () => st.getState().copyTrackKeys(menu.track) },
      clipCount > 0
        ? {
            label:
              menu.kind === 'lane'
                ? `Paste ${clipCount} ${keysWord(clipCount)} at ${menu.time.toFixed(2)}s`
                : `Paste ${clipCount} ${keysWord(clipCount)} into ${menuLabel} at the playhead`,
            run: () => st.getState().pasteKeys(menu.kind === 'lane' ? menu.time : undefined),
          }
        : { label: 'Paste — clipboard is empty', disabled: true },
      'sep',
      { label: `Remove all keys of ${menuLabel}`, danger: true, run: () => st.getState().deleteBoneKeys(menu.track) },
    );
  } else if (menu?.kind === 'ruler') {
    menuItems.push(
      clipCount > 0
        ? {
            label: `Paste ${clipCount} ${keysWord(clipCount)} at ${menu.time.toFixed(2)}s`,
            run: () => st.getState().pasteKeys(menu.time),
          }
        : { label: 'Paste — clipboard is empty', disabled: true },
    );
  }

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
          className="btn"
          title="Plant the lowest foot on the ground: re-solve the hips height from the leg poses (fixes floating feet)"
          onClick={() => st.getState().groundFeet()}
        >
          <Footprints size={14} /> Ground
        </button>
        <button
          className={`btn icon ${autoKey ? 'active' : ''}`}
          title="Auto-key: record while manipulating"
          onClick={() => st.getState().setAutoKey(!autoKey)}
        >
          <CircleDot size={15} />
        </button>
        <button
          className="btn icon"
          title="Copy selected keyframes (Ctrl/Cmd+C)"
          onClick={() => st.getState().copySelectedKeys()}
        >
          <Copy size={15} />
        </button>
        <button
          className="btn icon"
          title="Cut selected keyframes (Ctrl/Cmd+X)"
          onClick={() => st.getState().cutSelectedKeys()}
        >
          <Scissors size={15} />
        </button>
        <button
          className="btn icon"
          title={
            hasClipboard
              ? `Paste ${clipCount} key${clipCount === 1 ? '' : 's'} at the playhead (Ctrl/Cmd+V)`
              : 'Paste keyframes at the playhead (Ctrl/Cmd+V)'
          }
          disabled={!hasClipboard}
          onClick={() => st.getState().pasteKeys()}
        >
          <ClipboardPaste size={15} />
        </button>
        <button
          className="btn icon danger"
          title="Delete selected keyframes (Del)"
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
        <div className="tl-content" ref={contentRef} style={{ width: LABEL_W + contentW }}>
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
              onContextMenu={onRulerMenu}
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
              onDiamondMenu={onDiamondMenu}
              onLabelClick={onLabelClick}
              onLabelMenu={onLabelMenu}
              onLaneMenu={onLaneMenu}
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
                row.isExpr
                  ? selectedKey?.track === row.track
                  : row.track === HIPS_TRACK_ID
                    ? selectedBones.includes('hips')
                    : selectedBones.includes(row.track)
              }
              onScrubDown={onScrubDown}
              onScrubMove={onScrubMove}
              onScrubUp={onScrubUp}
              onDiamondDown={onDiamondDown}
              onDiamondMove={onDiamondMove}
              onDiamondUp={onDiamondUp}
              onDiamondMenu={onDiamondMenu}
              onLabelClick={onLabelClick}
              onLabelMenu={onLabelMenu}
              onLaneMenu={onLaneMenu}
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

          {/* Explorer-style drag-select rectangle */}
          {rectSelect && (
            <div
              className="tl-marquee rect"
              style={{
                left: rectSelect.left,
                top: rectSelect.top,
                width: rectSelect.width,
                height: rectSelect.height,
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

      {/* Right-click menu — select / copy / paste / remove per target. Every
          destructive action lives behind an explicit item; nothing is
          destroyed by the click that opens the menu. */}
      {menu && menuItems.length > 0 && (
        <div
          className="tl-menu"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
        >
          {menuItems.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="tl-menu-sep" />
            ) : (
              <button
                key={i}
                className={`tl-menu-item${it.danger ? ' danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  closeMenu();
                  it.run?.();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
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
