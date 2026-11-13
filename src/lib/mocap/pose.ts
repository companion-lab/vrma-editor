// Motion-reference video → pose frames via MediaPipe PoseLandmarker (WASM).
// Runs fully in the browser; the WASM runtime and the pose model are fetched
// from their CDNs on first use and cached by the browser afterwards.

import type { PoseLandmarker } from '@mediapipe/tasks-vision';

/** One tracked landmark (subset of MediaPipe's Landmark we actually use). */
export interface MocapLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface PoseFrame {
  /** Sample time in seconds (absolute in the video). */
  t: number;
  /** World landmarks: meters, origin at the hip midpoint. Axes follow the
   *  image: x right, y down, z smaller = closer to the camera. */
  world: MocapLandmark[];
  /** Image landmarks: normalized 0..1 per axis (y down). */
  image: MocapLandmark[];
}

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
}

export interface ExtractOptions {
  /** Sampling rate in frames per second (clamped 5..30, default 15). */
  fps?: number;
  /** Segment start in seconds (default 0). */
  start?: number;
  /** Segment end in seconds (default video duration). */
  end?: number;
  /** Progress callback (called on a throttled schedule). */
  onProgress?: (done: number, total: number) => void;
  /** Poll between frames — returning true stops the loop early. */
  cancelled?: () => boolean;
}

export interface ExtractResult {
  /** Frames where a person was detected, in time order. */
  frames: PoseFrame[];
  /** Sampled frames including misses (for coverage stats). */
  totalFrames: number;
  meta: VideoMeta;
  /** True when `cancelled()` fired before the whole span was processed. */
  cancelled: boolean;
}

const VISION_VERSION = '1.2.3';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

/** Longest span a single extraction call may process (keeps tool calls bounded
 *  and the UI responsive; ~15 fps × 60 s ≈ 900 detections). */
export const MAX_EXTRACT_SECONDS = 60;

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

/** Running detection timestamp. The PoseLandmarker's graph state persists for
 *  the singleton's lifetime and requires strictly increasing timestamps across
 *  every detectForVideo call — even across separate extractions — so a module
 *  counter continues where the last extraction stopped instead of restarting
 *  at the segment start. Uniform 1/fps steps mirror the real sampling cadence. */
let nextDetectTs = 0;

/** Lazily create the PoseLandmarker singleton (GPU delegate, CPU fallback).
 *  Shared by batch extraction and live tracking — one instance, one graph. */
export function getPoseLandmarker(): Promise<PoseLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
      const opts = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO' as const,
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try {
        return await vision.PoseLandmarker.createFromOptions(fileset, opts('GPU'));
      } catch {
        // GPU delegate can be unavailable (software WebGL, driver issues).
        return await vision.PoseLandmarker.createFromOptions(fileset, opts('CPU'));
      }
    })();
    // Allow a retry after a failed load (e.g. network hiccup).
    landmarkerPromise.catch(() => {
      landmarkerPromise = null;
    });
  }
  return landmarkerPromise;
}

/** Detect the pose in the CURRENT frame of a live video element (realtime
 *  tracking). Shares the landmarker singleton and the monotonic timestamp
 *  counter with batch extraction: `detectForVideo` timestamps must strictly
 *  increase across every call on the singleton, even across modes, so the
 *  counter continues from wherever extraction left off. Returns null when no
 *  person is detected. */
export async function detectPose(video: HTMLVideoElement, tSec: number): Promise<PoseFrame | null> {
  const landmarker = await getPoseLandmarker();
  nextDetectTs = Math.max(nextDetectTs + 1, Math.round(performance.now()));
  const res = landmarker.detectForVideo(video, nextDetectTs);
  const img = res.landmarks?.[0];
  const world = res.worldLandmarks?.[0];
  if (!img || !world || img.length < 33 || world.length < 33) return null;
  return {
    t: tSec,
    image: img.slice(0, 33).map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })),
    world: world.slice(0, 33).map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })),
  };
}

/** Single reusable video element for every mocap load. Chromium caps active
 *  media pipelines per page and only frees one when its element is destroyed:
 *  creating an element per load leaks pipelines until GC and eventually fails
 *  every load with `DEMUXER_ERROR_COULD_NOT_OPEN`. One persistent element
 *  swapped via load() keeps the footprint at exactly one, and re-setting the
 *  same src restarts resource selection cleanly after a failed attempt. */
let sharedVideo: HTMLVideoElement | null = null;
let sharedVideoSrc: string | null = null;

function getSharedVideo(): HTMLVideoElement {
  if (!sharedVideo) {
    sharedVideo = document.createElement('video');
    sharedVideo.muted = true;
    sharedVideo.preload = 'auto';
    sharedVideoSrc = null;
  }
  return sharedVideo;
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = getSharedVideo();
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onOk);
      video.removeEventListener('error', onErr);
    };
    const onOk = () => {
      cleanup();
      resolve(video);
    };
    const onErr = () => {
      cleanup();
      reject(new Error('The video could not be decoded (codec unsupported by this browser?).'));
    };
    video.addEventListener('loadedmetadata', onOk);
    video.addEventListener('error', onErr);
    if (sharedVideoSrc !== url) {
      sharedVideoSrc = url;
      video.src = url;
    }
    video.load(); // restart resource selection, even for the same src
  });
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - t) < 1e-4) {
      resolve();
      return;
    }
    // The element is shared (see getSharedVideo): a concurrent load() — e.g.
    // the user swapping the video mid-run — aborts pending seeks without
    // firing `seeked`. A timeout turns that hang into a clean failure.
    const on = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      video.removeEventListener('seeked', on);
      reject(new Error('Seek timed out — the video source changed mid-extraction.'));
    }, 8000);
    video.addEventListener('seeked', on);
    video.currentTime = t;
  });
}

/** Video metadata, recovering headerless WebM: MediaRecorder blobs (webcam
 *  recordings, synthetic clips) carry no Duration element and report a
 *  non-finite length. Seeking far past the end makes Chromium scan the whole
 *  file and populate the real duration. */
async function readVideoMeta(video: HTMLVideoElement): Promise<VideoMeta> {
  let duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!duration) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener('seeked', done, { once: true });
      setTimeout(done, 1500);
      video.currentTime = 1e6;
    });
    if (Number.isFinite(video.duration) && video.duration > 0) duration = video.duration;
    else if (video.seekable.length > 0) duration = video.seekable.end(video.seekable.length - 1);
  }
  return { duration, width: video.videoWidth || 0, height: video.videoHeight || 0 };
}

/** Read video metadata without decoding frames. */
export async function loadVideoMeta(url: string): Promise<VideoMeta> {
  const video = await loadVideo(url);
  return readVideoMeta(video);
}

/** Extract pose frames from a video: seek + detect at `fps`, skipping frames
 *  where no person is found. Detection is synchronous per frame (WASM), so
 *  the caller should surface progress. */
export async function extractPoses(url: string, o: ExtractOptions = {}): Promise<ExtractResult> {
  const landmarker = await getPoseLandmarker();
  const video = await loadVideo(url);
  const meta = await readVideoMeta(video);
  if (!meta.duration || !meta.width) {
    throw new Error('The video metadata is unreadable.');
  }

  const fps = Math.min(30, Math.max(5, o.fps ?? 15));
  const start = Math.max(0, Math.min(o.start ?? 0, meta.duration));
  const end = Math.max(start, Math.min(o.end ?? meta.duration, meta.duration));
  if (end - start > MAX_EXTRACT_SECONDS + 0.01) {
    throw new Error(
      `The requested span is ${(end - start).toFixed(1)}s — process at most ${MAX_EXTRACT_SECONDS}s per call (use start/end).`,
    );
  }

  const dt = 1 / fps;
  const count = Math.max(1, Math.floor((end - start) / dt) + 1);

  // Detect at (roughly) the model's input resolution; aspect is preserved.
  const scale = Math.min(1, 512 / Math.max(meta.width, meta.height));
  const cw = Math.max(2, Math.round(meta.width * scale));
  const ch = Math.max(2, Math.round(meta.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;

  const frames: PoseFrame[] = [];
  let cancelled = false;
  for (let i = 0; i < count; i++) {
    if (o.cancelled?.()) {
      cancelled = true;
      break;
    }
    const t = Math.min(start + i * dt, Math.max(0, end - 0.001));
    await seek(video, t);
    ctx.drawImage(video, 0, 0, cw, ch);
    nextDetectTs += Math.round(1000 / fps);
    const res = landmarker.detectForVideo(canvas, nextDetectTs);
    const img = res.landmarks?.[0];
    const world = res.worldLandmarks?.[0];
    if (img && world && img.length >= 33 && world.length >= 33) {
      frames.push({
        t,
        image: img.slice(0, 33).map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })),
        world: world.slice(0, 33).map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })),
      });
    }
    if (o.onProgress && (i % 8 === 0 || i === count - 1)) o.onProgress(i + 1, count);
  }

  return { frames, totalFrames: count, meta, cancelled };
}

/** Extract a segment of any length: `extractPoses` capped at
 *  {@link MAX_EXTRACT_SECONDS} per call (keeps one run bounded and the UI
 *  responsive), so longer spans are processed in consecutive chunks at the
 *  same fps — the sample times stay evenly spaced and the frame lists merge
 *  seamlessly. Progress covers the whole span; cancellation stops early. */
export async function extractPosesRange(url: string, o: ExtractOptions = {}): Promise<ExtractResult> {
  const meta = await loadVideoMeta(url);
  if (!meta.duration || !meta.width) {
    throw new Error('The video metadata is unreadable.');
  }
  const fps = Math.min(30, Math.max(5, o.fps ?? 15));
  const start = Math.max(0, Math.min(o.start ?? 0, meta.duration));
  const end = Math.max(start, Math.min(o.end ?? meta.duration, meta.duration));

  const frames: PoseFrame[] = [];
  let totalFrames = 0;
  let cancelled = false;
  const span = end - start;
  const totalSamples = Math.round(span * fps) + 1;
  for (let s = start; s < end - 1e-3; s += MAX_EXTRACT_SECONDS) {
    if (o.cancelled?.()) {
      cancelled = true;
      break;
    }
    const e = Math.min(s + MAX_EXTRACT_SECONDS, end);
    // Each chunk re-reports its local progress — rescale onto the whole span.
    const res = await extractPoses(url, {
      fps,
      start: s,
      end: e,
      cancelled: o.cancelled,
      onProgress: (done, total) => {
        const local = Math.min(1, done / Math.max(1, total));
        o.onProgress?.(Math.round((s - start + local * (e - s)) * fps) + 1, totalSamples);
      },
    });
    frames.push(...res.frames);
    totalFrames += res.totalFrames;
    if (res.cancelled) {
      cancelled = true;
      break;
    }
  }
  return { frames, totalFrames, meta, cancelled };
}
