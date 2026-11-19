import { useEffect, useRef, useState } from 'react';
import { Clapperboard, Film, Loader2, Radio, Square } from 'lucide-react';
import { useEditor } from '../store';
import { extractPosesRange, loadVideoMeta, type VideoMeta } from '../lib/mocap/pose';
import { retargetPoses } from '../lib/mocap/retarget';
import { liveTracker } from '../lib/mocap/live';

const FPS_OPTIONS = [10, 15, 24, 30];

interface TrackResult {
  frames: number;
  /** Detected frames / sampled frames, 0..1. */
  coverage: number;
  keys: number;
  trackCount: number;
  hipsKeys: number;
  /** Bones measured in < 40% of frames (usually occluded body parts). */
  sparse: string[];
}

// Right-panel Motion tab. Two ways in, one pipeline:
//  1. LIVE — the webcam tracks the user in real time and the loaded model
//     moves directly (liveTracker); with capture on, stopping builds the take
//     into a keyframe clip via retargetPoses and imports it.
//  2. VIDEO — a loaded video file is pose-tracked offline (extractPosesRange
//     → retargetPoses) and imported as the animation.
export function MotionPanel() {
  const motionVideoUrl = useEditor((s) => s.motionVideoUrl);
  const motionVideoName = useEditor((s) => s.motionVideoName);

  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);

  // live session (initialized from the tracker so a tab switch — which
  // remounts this panel — keeps reflecting a running session)
  const [live, setLive] = useState(() => liveTracker.active);
  const [liveCapture, setLiveCapture] = useState(() => liveTracker.captureVal() ?? true);
  const [liveSmooth, setLiveSmooth] = useState(() => liveTracker.smoothVal() ?? 2);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [liveStat, setLiveStat] = useState<string | null>(null);
  const camHostRef = useRef<HTMLDivElement>(null);

  // video source
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [fps, setFps] = useState(15);
  const [smooth, setSmooth] = useState(2);

  // video tracking run
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<TrackResult | null>(null);

  // New video source: load metadata, default the segment to the whole video.
  useEffect(() => {
    setMeta(null);
    setMetaErr(null);
    setResult(null);
    setProgress(null);
    if (!motionVideoUrl) return;
    let stale = false;
    loadVideoMeta(motionVideoUrl)
      .then((m) => {
        if (stale) return;
        setMeta(m);
        setStart(0);
        setEnd(m.duration > 0 ? m.duration : 0);
      })
      .catch((e) => {
        if (!stale) setMetaErr((e as Error).message);
      });
    return () => {
      stale = true;
    };
  }, [motionVideoUrl]);

  // Mount the live camera preview into its host while a session runs.
  useEffect(() => {
    const host = camHostRef.current;
    if (!live || !host) return;
    const preview = liveTracker.previewEl();
    if (preview) {
      preview.className = 'motion-cam';
      host.appendChild(preview);
    }
    return () => {
      preview?.remove();
    };
  }, [live]);

  // Live session stats (elapsed / detected fps).
  useEffect(() => {
    if (!live) return;
    const tick = () => {
      const s = liveTracker.stats();
      setLiveStat(
        s
          ? `${Math.min(60, s.fps).toFixed(0)} fps · ${s.elapsed.toFixed(1)}s · ${s.detected} frames · ${s.hands} hand frames`
          : null,
      );
    };
    tick();
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [live]);

  const loadFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const prev = useEditor.getState().motionVideoUrl;
    if (prev) URL.revokeObjectURL(prev);
    useEditor.getState().setMotionVideo(url, file.name);
  };

  const startLive = async () => {
    const st = useEditor.getState();
    if (!st.vrm) {
      st.setStatus('error', 'Load a model first — live tracking moves the loaded model.');
      return;
    }
    setLiveErr(null);
    st.setPlaying(false); // the timeline pauses; live motion owns the rig
    try {
      await liveTracker.start({
        smooth: liveSmooth,
        capture: liveCapture,
        onStatus: (msg) => useEditor.getState().setStatus('info', msg),
      });
      setLive(true);
      useEditor.getState().setStatus('ok', 'Live tracking started — the model follows you now');
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // Camera problems are local (permission/device) — only tracking-model
      // fetches get the CDN hint.
      const needsCdnHint = !/camera/i.test(msg) && /fetch|network|Failed|wasm|model/i.test(msg);
      setLiveErr(needsCdnHint ? `Pose tracking could not start (it fetches the MediaPipe WASM runtime + model from a CDN on first use — check connectivity): ${msg}` : msg);
    }
  };

  const stopLive = async () => {
    let res;
    try {
      res = await liveTracker.stop();
    } catch (err) {
      useEditor.getState().setStatus('error', `Live tracking failed to stop: ${(err as Error).message}`);
      return;
    }
    setLive(false);
    setLiveStat(null);
    if (!res || !liveCapture) {
      useEditor.getState().setStatus('ok', 'Live tracking stopped');
      return;
    }
    if (res.frames.length < 2) {
      useEditor
        .getState()
        .setStatus('error', 'No person was detected during the take — nothing was captured (full body works best).');
      return;
    }

    const name = 'Live take';
    const coverage = res.frames.length / Math.max(1, res.sampled);
    const clip = retargetPoses(
      res.frames,
      { name, start: 0, duration: res.duration, width: res.width, height: res.height },
      { smooth: liveSmooth, reductionDeg: 2 },
    );
    const keys = Object.values(clip.tracks).reduce((n, k) => n + k, 0) + clip.hipsKeys;
    const s = useEditor.getState();
    s.importAnim(clip.data);
    s.setPlaying(true);
    setResult({
      frames: res.frames.length,
      coverage,
      keys,
      trackCount: Object.keys(clip.tracks).length,
      hipsKeys: clip.hipsKeys,
      sparse: clip.sparseTracks,
    });
    s.setStatus('ok', `Captured ${res.frames.length} frames → ${keys} keys — imported as the current animation`);
  };

  const track = async () => {
    const s = useEditor.getState();
    if (!motionVideoUrl || !meta) return;
    const segStart = Math.min(Math.max(start, 0), meta.duration);
    const segEnd = Math.min(Math.max(end, segStart + 0.1), meta.duration);
    if (segEnd - segStart < 0.1) {
      s.setStatus('error', 'The segment is too short (min 0.1s).');
      return;
    }
    cancelRef.current = false;
    setBusy(true);
    setResult(null);
    setProgress({ done: 0, total: Math.round((segEnd - segStart) * fps) + 1 });
    const status = (kind: 'info' | 'ok' | 'error', msg: string) => useEditor.getState().setStatus(kind, msg);
    try {
      status('info', 'Loading the pose-tracking model…');
      const extract = await extractPosesRange(motionVideoUrl, {
        fps,
        start: segStart,
        end: segEnd,
        cancelled: () => cancelRef.current,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (extract.cancelled) {
        status('info', 'Tracking cancelled');
        return;
      }
      if (extract.frames.length < 2) {
        status(
          'error',
          'No person detected in the segment — check that the video actually shows a person (full body works best), or try another range.',
        );
        return;
      }

      const name = `${motionVideoName?.replace(/\.[^.]+$/, '') ?? 'Tracked motion'} (tracked)`;
      const res = retargetPoses(
        extract.frames,
        {
          name,
          start: segStart,
          duration: Math.max(0.1, segEnd - segStart),
          width: extract.meta.width,
          height: extract.meta.height,
        },
        { smooth, reductionDeg: 2 },
      );

      const coverage = extract.frames.length / Math.max(1, extract.totalFrames);
      const keys = Object.values(res.tracks).reduce((n, k) => n + k, 0) + res.hipsKeys;
      s.importAnim(res.data);
      s.setPlaying(true);
      setResult({
        frames: extract.frames.length,
        coverage,
        keys,
        trackCount: Object.keys(res.tracks).length,
        hipsKeys: res.hipsKeys,
        sparse: res.sparseTracks,
      });
      status('ok', `Tracked ${extract.frames.length} frames → ${keys} keys — imported as the current animation`);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      status(
        'error',
        /fetch|network|Failed|wasm|model/i.test(msg)
          ? `Pose tracking could not start (it fetches the MediaPipe WASM runtime + model from a CDN on first use — check connectivity): ${msg}`
          : msg,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className="motion-panel">
      <div className="panel-title">Live tracking</div>
      <div className="panel-body">
        {!live && (
          <div className="muted small">
            Track yourself with the webcam — the loaded model moves in real time, fingers included (when the hands are
            visible to the camera). Nothing is recorded; with capture on, stopping imports the take as the current
            animation. Runs in-browser (MediaPipe).
          </div>
        )}

        <div className="btn-row">
          {live ? (
            <button className="btn danger" onClick={stopLive} title="Stop tracking">
              <Square size={13} /> Stop
            </button>
          ) : (
            <button
              className="btn accent"
              onClick={startLive}
              title="Track your webcam and move the model in real time"
            >
              <Radio size={13} /> Start live
            </button>
          )}
        </div>
        {liveErr && <div className="motion-warn">{liveErr}</div>}
        {live && (
          <>
            <div className="motion-cam-host" ref={camHostRef} />
            <div className="ctl-row">
              <span>Smoothing</span>
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={liveSmooth}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  setLiveSmooth(n);
                  liveTracker.setSmooth(n);
                }}
              />
              <span className="ctl-val">{liveSmooth}</span>
            </div>
            <label className="ctl-row">
              <input
                type="checkbox"
                checked={liveCapture}
                onChange={(e) => {
                  setLiveCapture(e.target.checked);
                  liveTracker.setCapture(e.target.checked);
                }}
              />
              <span>Capture keyframes — stop imports the take</span>
            </label>
            <div className="muted small">{liveStat ?? 'waiting for the camera…'}</div>
          </>
        )}
      </div>

      {result && (
        <>
          <div className="panel-title">Result</div>
          <div className="panel-body">
            <div className="stat-row">
              <span>Frames tracked</span>
              <span>{result.frames}</span>
            </div>
            <div className="stat-row">
              <span>Coverage</span>
              <span>{(result.coverage * 100).toFixed(0)}%</span>
            </div>
            <div className="stat-row">
              <span>Bone tracks</span>
              <span>{result.trackCount}</span>
            </div>
            <div className="stat-row">
              <span>Keys (rot + hips)</span>
              <span>{result.keys}</span>
            </div>
            {result.coverage < 0.7 && (
              <div className="motion-warn">
                Only {(result.coverage * 100).toFixed(0)}% of sampled frames had a detectable person — consider a
                cleaner take or segment.
              </div>
            )}
            {result.sparse.length > 0 && (
              <div className="motion-warn">Sparse tracks (often occluded): {result.sparse.join(', ')}.</div>
            )}
            <div className="muted small">
              Imported as the current animation (one undo step) and playing. Clean it up on the timeline — delete noisy
              tracks, add easing — then Export VRMA.
            </div>
          </div>
        </>
      )}

      <div className="panel-title">From a video</div>
      <div className="panel-body">
        {!motionVideoUrl && (
          <div className="muted small">
            Or pose-track a video file (mp4/webm/mov) — the person's motion becomes keyframe animation. Everything stays
            in the browser.
          </div>
        )}

        <div className="btn-row">
          <button
            className="btn"
            onClick={() => fileRef.current?.click()}
            title="Load a motion-reference video (mp4/webm/mov)"
          >
            <Film size={13} /> {motionVideoName ? 'Replace video' : 'Load video'}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
          hidden
          onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
        />
        {motionVideoUrl && !live && <video className="motion-preview" src={motionVideoUrl} controls muted playsInline />}
        {motionVideoName && (
          <div className="stat-row">
            <span>Video</span>
            <span className="motion-name" title={motionVideoName}>
              {motionVideoName}
            </span>
          </div>
        )}
        {meta && (
          <div className="stat-row">
            <span>Duration / size</span>
            <span>
              {meta.duration.toFixed(2)}s · {meta.width}×{meta.height}
            </span>
          </div>
        )}
        {metaErr && <div className="motion-warn">{metaErr}</div>}

        {motionVideoUrl && meta && (
          <>
            <div className="section-label">Segment &amp; settings</div>
            <label className="field">
              <span>Start (s)</span>
              <input
                type="number"
                min={0}
                max={meta.duration}
                step={0.1}
                value={Math.round(start * 100) / 100}
                onChange={(e) => setStart(parseFloat(e.target.value) || 0)}
              />
            </label>
            <label className="field">
              <span>End (s)</span>
              <input
                type="number"
                min={0}
                max={meta.duration}
                step={0.1}
                value={Math.round(end * 100) / 100}
                onChange={(e) => setEnd(parseFloat(e.target.value) || 0)}
              />
            </label>
            <label className="field">
              <span>Sample rate</span>
              <select value={fps} onChange={(e) => setFps(parseInt(e.target.value, 10))}>
                {FPS_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>
            <div className="ctl-row">
              <span>Smoothing</span>
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={smooth}
                onChange={(e) => setSmooth(parseInt(e.target.value, 10))}
              />
              <span className="ctl-val">{smooth}</span>
            </div>
            <div className="muted small">
              Smoothing is a moving-average window per side (0 = raw tracking). Higher tames jitter but softens fast
              motion. Long segments are processed in 60 s chunks automatically.
            </div>

            <div className="btn-row">
              <button className="btn accent" onClick={track} disabled={busy}>
                {busy ? <Loader2 className="spin" size={13} /> : <Clapperboard size={13} />} Track motion
              </button>
              {busy && (
                <button className="btn" onClick={() => (cancelRef.current = true)}>
                  Cancel
                </button>
              )}
            </div>
            {busy && progress && (
              <>
                <div className="motion-progress">
                  <div
                    className="motion-progress-fill"
                    style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }}
                  />
                </div>
                <div className="muted small">
                  {progress.done}/{progress.total} frames — the first run also downloads the tracking model (~5 MB) and
                  is cached afterwards.
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
