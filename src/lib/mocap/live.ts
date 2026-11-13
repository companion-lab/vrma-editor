// Realtime motion tracking: webcam → MediaPipe per frame → retarget → the
// loaded model moves live. No video is recorded; optionally the detected
// frames are buffered so stopping can build a keyframe clip through the same
// `retargetPoses` path a video import takes.
//
// The tracker is a preview override: the Viewport's render loop calls
// `liveTracker.applyTo` instead of `applyPose` while a session is active, so
// stopping instantly hands the rig back to the timeline sampler.

import type { VRM } from '@pixiv/three-vrm';
import { Quaternion, Vector3 } from 'three';
import { getNormNode } from '../animation';
import { detectPose, getPoseLandmarker, type PoseFrame } from './pose';
import { retargetFrame, type FrameResult, type RetargetInfo } from './retarget';
import { cameraPreview, openCamera } from './webcam';

export interface LiveOptions {
  /** Preview smoothing, 0..10 (0 = raw tracking). */
  smooth?: number;
  /** Buffer detected frames so stop() can hand them to retargetPoses. */
  capture?: boolean;
  /** Session progress surface (model download, camera opening). */
  onStatus?: (msg: string) => void;
}

export interface LiveResult {
  frames: PoseFrame[];
  /** Attempted samples including misses (for coverage stats). */
  sampled: number;
  /** Session length in seconds. */
  duration: number;
  width: number;
  height: number;
}

export interface LiveStats {
  /** Seconds since start. */
  elapsed: number;
  /** Frames where a person was detected. */
  detected: number;
  /** Measured detection rate, fps. */
  fps: number;
}

/** The active realtime session, if any (module singleton). */
let currentSession: LiveSession | null = null;

class LiveSession {
  preview: HTMLVideoElement;
  private stream: MediaStream;
  private smooth = 2;
  private capture = true;
  private onStatus?: (msg: string) => void;

  private raf = 0;
  private t0 = 0;
  private stopped = false;
  private busy = false;
  private detected = 0;
  private sampled = 0;
  private detectTimes: number[] = [];
  private frames: PoseFrame[] = [];
  private width = 0;
  private height = 0;
  private prevMirror = false;

  // Smoothing state (canonical space).
  private smoothedRot = new Map<string, Quaternion>();
  private smoothedHips: Vector3 | null = null;
  private hipsRest: Vector3 | null = null;
  // One-shot rig reset on the first applied pose (the tracking "engages").
  private initialized = false;

  private constructor(stream: MediaStream, opts: LiveOptions) {
    this.stream = stream;
    this.smooth = Math.min(10, Math.max(0, opts.smooth ?? 2));
    this.capture = opts.capture ?? true;
    this.onStatus = opts.onStatus;
    this.preview = cameraPreview(stream);
  }

  static async start(opts: LiveOptions): Promise<LiveSession> {
    opts.onStatus?.('Opening the camera…');
    const stream = await openCamera();
    const session = new LiveSession(stream, opts);
    session.onStatus?.('Loading the pose-tracking model…');
    await getPoseLandmarker(); // first use downloads ~5 MB from the CDN
    if (session.stopped) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('Live tracking was cancelled.');
    }
    session.t0 = performance.now();
    session.tick();
    return session;
  }

  private tick = () => {
    if (this.stopped) return;
    this.raf = requestAnimationFrame(this.tick);
    if (this.busy) return; // previous detection still in flight
    const v = this.preview;
    if (v.readyState < 2 || !v.videoWidth) return;
    if (!this.width) {
      this.width = v.videoWidth;
      this.height = v.videoHeight;
    }
    this.sampled++;
    this.busy = true;
    const t = (performance.now() - this.t0) / 1000;
    detectPose(v, t)
      .then((frame) => {
        this.busy = false;
        if (!this.stopped) this.onFrame(frame);
      })
      .catch(() => {
        this.busy = false; // transient detection failure — try the next frame
      });
  };

  private onFrame(frame: PoseFrame | null) {
    if (!frame) return; // no person this frame — hold the last pose
    this.detected++;
    this.detectTimes.push(performance.now());
    if (this.detectTimes.length > 30) this.detectTimes.shift();
    if (this.capture) this.frames.push(frame);

    // retargetFrame only reads width/height from the info.
    const info: RetargetInfo = { name: 'live', start: 0, duration: 1, width: this.width, height: this.height };
    const r = retargetFrame(frame, info, this.prevMirror);
    this.prevMirror = r.mirror;
    this.smoothTo(r);
  }

  /** Exponential per-bone smoothing: each detected frame slerps the held pose
   *  toward the measurement. Unmeasured bones hold their last value (no
   *  T-pose flicker on brief occlusion). */
  private smoothTo(r: FrameResult) {
    const a = 1 / (1 + this.smooth * 0.6);
    for (const [bone, q] of r.rot) {
      const prev = this.smoothedRot.get(bone);
      if (!prev) this.smoothedRot.set(bone, q.clone());
      else prev.slerp(q, a);
    }
    if (r.hips) {
      if (!this.hipsRest) this.hipsRest = r.hips.clone();
      const off = r.hips.clone().sub(this.hipsRest);
      if (this.smoothedHips) this.smoothedHips.lerp(off, a);
      else this.smoothedHips = off;
    }
  }

  setSmooth(n: number) {
    this.smooth = Math.min(10, Math.max(0, n));
  }

  getSmooth(): number {
    return this.smooth;
  }

  setCapture(b: boolean) {
    this.capture = b;
  }

  getCapture(): boolean {
    return this.capture;
  }

  stats(): LiveStats {
    const now = performance.now();
    const span = this.detectTimes.length > 1 ? (now - this.detectTimes[0]) / 1000 : 0;
    return {
      elapsed: (now - this.t0) / 1000,
      detected: this.detected,
      fps: span > 0 ? this.detectTimes.length / span : 0,
    };
  }

  /** Write the tracked pose onto the rig (Viewport tick, live session active).
   *  Hips keeps the model's rest height and adds the tracked bob/sway — the
   *  same scale convention as playing a mocap-imported clip. */
  applyTo(vrm: VRM, restHipsPos: Vector3) {
    const humanoid = vrm.humanoid;
    if (!humanoid) return;
    const flip = vrm.meta?.metaVersion === '0';
    if (!this.initialized) {
      // First tracked pose: start from T-pose at the rest height so the take
      // begins from a known baseline instead of the timeline pose.
      for (const bone of Object.keys(humanoid.humanBones)) {
        getNormNode(vrm, bone)?.quaternion.identity();
      }
      getNormNode(vrm, 'hips')?.position.copy(restHipsPos);
      this.initialized = true;
    }
    for (const [bone, q] of this.smoothedRot) {
      const node = getNormNode(vrm, bone);
      if (!node) continue;
      node.quaternion.set(flip ? -q.x : q.x, q.y, flip ? -q.z : q.z, q.w);
    }
    if (this.smoothedHips) {
      const hips = getNormNode(vrm, 'hips');
      if (hips) {
        const s = restHipsPos.y > 1e-3 ? restHipsPos.y : 1;
        const o = this.smoothedHips;
        hips.position.set(
          restHipsPos.x + (flip ? -o.x : o.x) * s,
          restHipsPos.y + o.y * s,
          restHipsPos.z + (flip ? -o.z : o.z) * s,
        );
      }
    }
    humanoid.update();
  }

  async stop(): Promise<LiveResult> {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    for (const t of this.stream.getTracks()) t.stop();
    this.preview.srcObject = null;
    currentSession = null;
    return {
      frames: this.frames,
      sampled: this.sampled,
      duration: Math.max(0.1, (performance.now() - this.t0) / 1000),
      width: this.width,
      height: this.height,
    };
  }

}

/** Realtime tracking controller. One session at a time; the Viewport render
 *  loop reads `active` every frame and routes the rig through `applyTo`. */
export const liveTracker = {
  get active(): boolean {
    return currentSession != null;
  },

  /** The live camera preview element to attach to the DOM (null when idle). */
  previewEl(): HTMLVideoElement | null {
    return currentSession?.preview ?? null;
  },

  async start(opts: LiveOptions = {}): Promise<void> {
    if (currentSession) throw new Error('Live tracking is already running.');
    currentSession = await LiveSession.start(opts);
  },

  setSmooth(n: number) {
    currentSession?.setSmooth(n);
  },

  setCapture(b: boolean) {
    currentSession?.setCapture(b);
  },

  /** Current session settings — the panel reads these on remount (tab
   *  switches) so its toggles reflect the running session. */
  smoothVal(): number | null {
    return currentSession?.getSmooth() ?? null;
  },

  captureVal(): boolean | null {
    return currentSession?.getCapture() ?? null;
  },

  stats(): LiveStats | null {
    return currentSession?.stats() ?? null;
  },

  /** Stop the session. With capture on, `result.frames` feeds `retargetPoses`
   *  to build the take's keyframe clip (empty when capture was off). */
  async stop(): Promise<LiveResult | null> {
    const s = currentSession;
    if (!s) return null;
    return await s.stop();
  },

  /** Called by the Viewport render loop while a session is active. */
  applyTo(vrm: VRM, restHipsPos: Vector3) {
    currentSession?.applyTo(vrm, restHipsPos);
  },
};
