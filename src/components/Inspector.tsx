import { useEffect, useMemo } from 'react';
import { ChevronRight, Diamond, Eraser, KeyRound, RotateCcw, Undo2, Wand2 } from 'lucide-react';
import { Euler, Quaternion } from 'three';
import { useEditor, HIPS_TRACK_ID, countModelEdits, exprTrackId, exprNameOf, isExprTrack } from '../store';
import { getNormNode, manipulatedExpressions } from '../lib/animation';
import { EASES, seedBez, type Ease } from '../lib/vrma/parse';
import { prettyBoneName } from '../lib/humanoid';
import { applyExpressionWeight, expressionNames } from '../lib/vrmedit/live';
import { ModelPanel } from './ModelPanel';
import { AIPanel } from './AIPanel';
import { MotionPanel } from './MotionPanel';
import { EaseCurve } from './EaseCurve';
import { PanelResizeHandle } from './PanelResize';

const EASE_LABELS: Record<Ease, string> = {
  linear: 'Linear (constant speed)',
  in: 'Ease in (slow → fast)',
  out: 'Ease out (fast → slow)',
  inout: 'Ease in-out (smooth)',
  step: 'Step (hold until next key)',
  custom: 'Custom — drag handles below',
};

const DEG = 180 / Math.PI;

const wrapPi = (r: number): number => {
  let v = r;
  while (v > Math.PI) v -= 2 * Math.PI;
  while (v < -Math.PI) v += 2 * Math.PI;
  return v;
};

// Last displayed/applied euler per bone (radians). A quaternion has TWO valid
// YXZ euler decompositions — (x, y, z) and (180°−x, y+180°, z+180°) — and
// three.js extraction picks the one that clamps X to ±90° (asin). Without a
// branch preference the X slider snaps back: a 180° X rotation reads 0°, a
// 100° elbow reads 80° with Y/Z jumping to ±180°. Remembering the previous
// euler lets us keep the branch the user is posing in, so the sliders stay
// continuous through the whole ±180° range.
const LAST_EULER = new Map<string, { x: number; y: number; z: number }>();

const eulerDist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.abs(wrapPi(a.x - b.x)) + Math.abs(wrapPi(a.y - b.y)) + Math.abs(wrapPi(a.z - b.z));

// Euler slider for one axis, reading/writing the live normalized bone.
// Degrees are in canonical animation space (identity = T-pose, model facing
// +Z — the same convention as add_rotation_key and the docs' verified
// examples). VRM 0.x normalized rigs face the opposite way, so their live
// quaternions are conjugated (x/z negated) on both read and write.
function EulerAxis({ axis }: { axis: 'x' | 'y' | 'z' }) {
  const poseTick = useEditor((s) => s.poseTick);
  const selectedBone = useEditor((s) => s.selectedBone);
  const vrm = useEditor((s) => s.vrm);
  const flip = vrm?.meta?.metaVersion === '0';

  // Fresh model — the branch memory no longer matches its poses.
  useEffect(() => {
    LAST_EULER.clear();
  }, [vrm]);

  const euler = useMemo<Euler | null>(() => {
    void poseTick;
    const node = vrm ? getNormNode(vrm, selectedBone ?? '') : null;
    if (!node) return null;
    node.quaternion.normalize();
    const q = node.quaternion.clone();
    if (flip) q.set(-q.x, q.y, -q.z, q.w); // live -> canonical
    const e = new Euler().setFromQuaternion(q, 'YXZ');
    const prev = selectedBone ? LAST_EULER.get(selectedBone) : undefined;
    if (prev) {
      // Same rotation on the other branch: X mirrors around ±90°, Y and Z
      // shift by 180°. Prefer it when it lies closer to the previous euler.
      const flipBranch = { x: wrapPi(Math.PI - e.x), y: wrapPi(e.y + Math.PI), z: wrapPi(e.z + Math.PI) };
      if (eulerDist(flipBranch, prev) < eulerDist({ x: e.x, y: e.y, z: e.z }, prev) - 1e-9) {
        e.set(flipBranch.x, flipBranch.y, flipBranch.z, 'YXZ');
      }
    }
    if (selectedBone) LAST_EULER.set(selectedBone, { x: e.x, y: e.y, z: e.z });
    return e;
  }, [poseTick, selectedBone, vrm, flip]);

  if (!euler) return null;
  const deg = Math.round(euler[axis] * DEG * 10) / 10;

  const apply = (newDeg: number) => {
    const st = useEditor.getState();
    const node = st.vrm ? getNormNode(st.vrm, st.selectedBone ?? '') : null;
    if (!node) return;
    euler[axis] = newDeg / DEG;
    if (st.selectedBone) LAST_EULER.set(st.selectedBone, { x: euler.x, y: euler.y, z: euler.z });
    const q = new Quaternion().setFromEuler(euler);
    if (flip) q.set(-q.x, q.y, -q.z, q.w); // canonical -> live
    node.quaternion.copy(q);
    st.manipulateBone(st.selectedBone!, 'rot');
  };

  return (
    <div className="axis-row">
      <span className={`axis axis-${axis}`}>{axis.toUpperCase()}</span>
      <input
        type="range"
        min={-180}
        max={180}
        step={0.5}
        value={Number.isFinite(deg) ? deg : 0}
        onPointerDown={() => useEditor.getState().beginPoseStroke()}
        onChange={(e) => apply(parseFloat(e.target.value))}
      />
      <input
        className="num"
        type="number"
        value={Number.isFinite(deg) ? deg : 0}
        step={1}
        onChange={(e) => apply(parseFloat(e.target.value) || 0)}
      />
      <span className="unit">°</span>
    </div>
  );
}

function HipsAxis({ axis, index }: { axis: 'x' | 'y' | 'z'; index: 0 | 1 | 2 }) {
  const poseTick = useEditor((s) => s.poseTick);
  const vrm = useEditor((s) => s.vrm);
  const rest = useEditor((s) => s.restHipsPos);

  const value = useMemo(() => {
    void poseTick;
    const node = vrm ? getNormNode(vrm, 'hips') : null;
    if (!node) return 0;
    return node.position.getComponent(index) - rest.getComponent(index);
  }, [poseTick, vrm, rest, index]);

  const apply = (v: number) => {
    const st = useEditor.getState();
    const node = st.vrm ? getNormNode(st.vrm, 'hips') : null;
    if (!node) return;
    const p = node.position.clone().sub(rest);
    p.setComponent(index, v);
    node.position.copy(rest).add(p);
    st.manipulateBone('hips', 'hipsPos');
  };

  return (
    <div className="axis-row">
      <span className={`axis axis-${axis}`}>{axis.toUpperCase()}</span>
      <input
        type="range"
        min={-1}
        max={1}
        step={0.005}
        value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0}
        onPointerDown={() => useEditor.getState().beginPoseStroke()}
        onChange={(e) => apply(parseFloat(e.target.value))}
      />
      <input
        className="num"
        type="number"
        value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0}
        step={0.01}
        onChange={(e) => apply(parseFloat(e.target.value) || 0)}
      />
      <span className="unit">m</span>
    </div>
  );
}

// Transition (velocity) settings for the keyframe selected on the timeline.
function KeyTransition() {
  const selectedKey = useEditor((s) => s.selectedKey);
  const rotTracks = useEditor((s) => s.rotTracks);
  const hipsTrack = useEditor((s) => s.hipsTrack);
  const exprTracks = useEditor((s) => s.exprTracks);

  const key = useMemo(() => {
    if (!selectedKey) return null;
    if (selectedKey.track === HIPS_TRACK_ID) {
      return hipsTrack.find((k) => k.id === selectedKey.id) ?? null;
    }
    if (isExprTrack(selectedKey.track)) {
      return exprTracks[exprNameOf(selectedKey.track)]?.find((k) => k.id === selectedKey.id) ?? null;
    }
    return rotTracks[selectedKey.track]?.find((k) => k.id === selectedKey.id) ?? null;
  }, [selectedKey, rotTracks, hipsTrack, exprTracks]);

  if (!selectedKey || !key) return null;
  const isHips = selectedKey.track === HIPS_TRACK_ID;
  const isExpr = isExprTrack(selectedKey.track);
  const trackKeys = isHips
    ? hipsTrack
    : isExpr
      ? exprTracks[exprNameOf(selectedKey.track)] ?? []
      : rotTracks[selectedKey.track] ?? [];
  const isLast = trackKeys.length > 0 && trackKeys[trackKeys.length - 1].id === key.id;
  const ease = key.ease ?? 'linear';
  const trackLabel = isHips
    ? 'hips position'
    : isExpr
      ? `expression: ${exprNameOf(selectedKey.track)}`
      : prettyBoneName(selectedKey.track);

  return (
    <>
      <div className="section-label">
        Transition · key @ {key.t.toFixed(2)}s · {trackLabel}
      </div>
      <select
        className="wide"
        value={ease}
        onChange={(e) => {
          const st = useEditor.getState();
          const val = e.target.value as Ease;
          st.setKeyEase(selectedKey.track, key.id, val, val === 'custom' ? seedBez(key.ease) : undefined);
        }}
      >
        {EASES.map((e) => (
          <option key={e} value={e}>
            {EASE_LABELS[e]}
          </option>
        ))}
      </select>
      {ease === 'custom' && !isLast && (
        <EaseCurve
          bez={key.bez}
          strokeStart={() => useEditor.getState().pushHistory()}
          onChange={(bez) =>
            useEditor.getState().setKeyEase(selectedKey.track, key.id, 'custom', bez, { history: false })
          }
        />
      )}
      <div className="muted small" style={{ marginTop: 4 }}>
        {isLast
          ? 'This is the last key of the track — its transition has no next segment to affect.'
          : 'Velocity of the movement leaving this key toward the next one. Non-linear transitions are baked to linear keys on VRMA export.'}
      </div>
      <div className="btn-row">
        <button
          className="btn"
          title="Apply this transition to every key of the track"
          onClick={() =>
            useEditor.getState().setTrackEase(
              selectedKey.track,
              ease,
              ease === 'custom' ? (key.bez ?? seedBez(ease)) : undefined,
            )
          }
        >
          <Wand2 size={13} /> Apply to track
        </button>
      </div>
    </>
  );
}

// Animation-side expression posing: one slider per model expression that
// previews live and (with auto-key) records keys, plus a key button per row —
// the face counterpart of the bone sliders / "Key (K)". These write animation
// data; the Model tab's sliders write the static rest-face edit.
function ExpressionsPose() {
  const vrm = useEditor((s) => s.vrm);
  const poseTick = useEditor((s) => s.poseTick);
  const time = useEditor((s) => s.time);
  const exprTracks = useEditor((s) => s.exprTracks);

  const names = useMemo(() => (vrm ? expressionNames(vrm) : []), [vrm]);

  // Live weights, refreshed on pose strokes and on playhead moves (the
  // expression sampler writes values when scrubbing/playing).
  const weights = useMemo(() => {
    void poseTick;
    void time;
    const mgr = vrm?.expressionManager;
    return new Map(names.map((n) => [n, mgr?.getValue(n) ?? 0]));
  }, [vrm, names, poseTick, time]);

  if (!vrm || names.length === 0) return null;

  const apply = (name: string, w: number) => {
    const st = useEditor.getState();
    applyExpressionWeight(vrm, name, w);
    st.manipulateExpression(name, w);
  };

  return (
    <>
      <div className="panel-title">Expressions</div>
      <div className="panel-body">
        <div className="btn-row">
          <button
            className="btn"
            title="Reset every expression weight to its rest value (model edit or file default — does not touch keyframes)"
            onClick={() => {
              const st = useEditor.getState();
              if (!st.vrm) return;
              st.pushHistory();
              for (const n of names) {
                manipulatedExpressions.delete(n);
                applyExpressionWeight(st.vrm, n, st.modelEdits.expressions[n] ?? st.modelBakedExpressions[n] ?? 0);
              }
              st.bumpPose();
            }}
          >
            <RotateCcw size={13} /> Rest face
          </button>
          <span className="muted small">pose the face, then key it</span>
        </div>
        {names.map((n) => {
          const w = weights.get(n) ?? 0;
          const keys = exprTracks[n]?.length ?? 0;
          return (
            <div className="ctl-row" key={n}>
              <span className="expr-name" title={n}>{n}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={w}
                onPointerDown={() => useEditor.getState().beginPoseStroke()}
                onChange={(e) => apply(n, parseFloat(e.target.value))}
              />
              <span className="ctl-val">{w.toFixed(2)}</span>
              <button
                className="btn small"
                title={`Key "${n}" at the playhead with its current weight`}
                onClick={() => useEditor.getState().upsertExprKey(n, vrm.expressionManager?.getValue(n) ?? 0)}
              >
                <Diamond size={11} />
              </button>
              {keys > 0 && (
                <button
                  className="btn small danger"
                  title={`Remove the whole "${n}" animation track (${keys} keys)`}
                  onClick={() => useEditor.getState().deleteBoneKeys(exprTrackId(n))}
                >
                  <Eraser size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function PoseInspector() {
  const selectedBone = useEditor((s) => s.selectedBone);
  const vrm = useEditor((s) => s.vrm);
  const rotTracks = useEditor((s) => s.rotTracks);
  const hipsTrack = useEditor((s) => s.hipsTrack);
  const exprTracks = useEditor((s) => s.exprTracks);
  const animName = useEditor((s) => s.animName);
  const duration = useEditor((s) => s.duration);
  const keyCount = useMemo(
    () => Object.values(rotTracks).reduce((n, k) => n + (k?.length ?? 0), 0),
    [rotTracks],
  );
  const exprKeyCount = useMemo(
    () => Object.values(exprTracks).reduce((n, k) => n + k.length, 0),
    [exprTracks],
  );

  const node = selectedBone && vrm ? getNormNode(vrm, selectedBone) : null;

  return (
    <>
    <div className="panel-body pose-body">
        <KeyTransition />
        {!vrm && <div className="muted pad">Load a model first.</div>}
        {vrm && !selectedBone && (
          <div className="muted pad">
            Select a bone in the tree. Rotate it with the gizmo in the viewport or the sliders here.
          </div>
        )}

        {vrm && selectedBone && node && (
          <>
            <div className="sel-bone">
              <span className="sel-bone-name">{prettyBoneName(selectedBone)}</span>
              <span className="muted small">{selectedBone}</span>
            </div>

            <div className="section-label">Rotation</div>
            <EulerAxis axis="x" />
            <EulerAxis axis="y" />
            <EulerAxis axis="z" />

            {selectedBone === 'hips' && (
              <>
                <div className="section-label">Position offset (from T-pose)</div>
                <HipsAxis axis="x" index={0} />
                <HipsAxis axis="y" index={1} />
                <HipsAxis axis="z" index={2} />
              </>
            )}

            <div className="btn-row">
              <button className="btn accent" onClick={() => useEditor.getState().keySelectedBone()}>
                <KeyRound size={14} /> Key (K)
              </button>
              <button
                className="btn"
                title="Reset this bone to T-pose"
                onClick={() => {
                  const st = useEditor.getState();
                  const n = st.vrm ? getNormNode(st.vrm, st.selectedBone!) : null;
                  if (!n) return;
                  st.beginPoseStroke();
                  n.quaternion.identity();
                  st.manipulateBone(st.selectedBone!, 'rot');
                }}
              >
                <RotateCcw size={13} /> Reset
              </button>
              {(rotTracks[selectedBone]?.length ?? 0) > 0 && (
                <button
                  className="btn danger"
                  title="Delete all keyframes of this bone"
                  onClick={() => useEditor.getState().deleteBoneKeys(selectedBone)}
                >
                  <Eraser size={13} /> Keys ({rotTracks[selectedBone]!.length})
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="panel-title">Animation</div>
      <div className="panel-body">
        <label className="field">
          <span>Name</span>
          <input
            value={animName}
            onChange={(e) => useEditor.getState().setAnimName(e.target.value)}
          />
        </label>
        <div className="stat-row">
          <span>Duration</span>
          <span>{duration.toFixed(2)}s</span>
        </div>
        <div className="stat-row">
          <span>Keyed bones</span>
          <span>{Object.keys(rotTracks).filter((b) => (rotTracks[b]?.length ?? 0) > 0).length}</span>
        </div>
        <div className="stat-row">
          <span>Rotation keys</span>
          <span>{keyCount}</span>
        </div>
        <div className="stat-row">
          <span>Hips position keys</span>
          <span>{hipsTrack.length}</span>
        </div>
        <div className="stat-row">
          <span>Expression keys</span>
          <span>{exprKeyCount}</span>
        </div>

        <div className="btn-row">
          <button
            className="btn"
            title="Reset the whole model to T-pose (does not touch keyframes)"
            onClick={() => {
              const st = useEditor.getState();
              if (!st.vrm) return;
              st.pushHistory();
              st.resetPose();
              st.setStatus('info', 'Pose reset to T-pose');
            }}
          >
            <Undo2 size={13} /> T-pose
          </button>
          <button
            className="btn"
            title="Key the whole current pose at the playhead"
            onClick={() => useEditor.getState().keyAllBones()}
          >
            <Diamond size={13} /> Key all
          </button>
        </div>
    </div>

    <ExpressionsPose />
    </>
  );
}

// Right panel: tabs between the pose inspector and the VRM Studio-style
// model editor (materials / expressions / meta / proportions).
export function Inspector() {
  const tab = useEditor((s) => s.rightTab);
  const editCount = useEditor((s) => countModelEdits(s.modelEdits));
  const rightW = useEditor((s) => s.rightW);

  return (
    <div className="panel inspector" style={{ width: rightW }}>
      <PanelResizeHandle edge="left" />
      <div className="panel-tabs">
        <button
          className={tab === 'pose' ? 'active' : ''}
          onClick={() => useEditor.getState().setRightTab('pose')}
        >
          Pose
        </button>
        <button
          className={tab === 'motion' ? 'active' : ''}
          title="Track motion from a video or webcam and import it as the animation"
          onClick={() => useEditor.getState().setRightTab('motion')}
        >
          Motion
        </button>
        <button
          className={tab === 'model' ? 'active' : ''}
          onClick={() => useEditor.getState().setRightTab('model')}
        >
          Model{editCount > 0 ? ` (${editCount})` : ''}
        </button>
        <button
          className={tab === 'ai' ? 'active' : ''}
          onClick={() => useEditor.getState().setRightTab('ai')}
        >
          AI
        </button>
        <span className="panel-tabs-spacer" />
        <button
          className="title-btn"
          title="Hide panel (toolbar toggle brings it back)"
          onClick={() => useEditor.getState().setRightOpen(false)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
      {tab === 'pose' ? (
        <PoseInspector />
      ) : tab === 'motion' ? (
        <MotionPanel />
      ) : tab === 'model' ? (
        <ModelPanel />
      ) : (
        <AIPanel />
      )}
    </div>
  );
}
