// Webcam capture: getUserMedia + MediaRecorder → a webm blob that the motion
// tracker treats exactly like any other motion-reference video. The whole
// recording stays in memory in this tab — nothing is uploaded.

export interface WebcamRecording {
  blob: Blob;
  /** Object URL of the recording (caller owns revoking it). */
  url: string;
}

export interface WebcamSession {
  /** Live camera preview element (append it to the DOM to show it). */
  preview: HTMLVideoElement;
  /** performance.now() when recording started (for elapsed-time display). */
  startedAt: number;
  /** Stop recording and finish the file. */
  stop: () => Promise<WebcamRecording>;
  /** Tear down the camera without producing a file. */
  abort: () => void;
}

function pickMime(): string | undefined {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined;
}

/** Open the user's camera (no recording). Shared by the webcam recorder and
 *  the realtime tracker. */
export async function openCamera(opts: { width?: number; height?: number } = {}): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not expose a webcam API (getUserMedia) — load a video file instead.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: opts.width ?? 1280, height: opts.height ?? 720, facingMode: 'user' },
      audio: false,
    });
  } catch (err) {
    throw new Error(`Camera access failed or was denied: ${(err as Error)?.message ?? String(err)}`);
  }
}

/** A muted, already-playing preview element for a camera stream (callers
 *  append it to the DOM to show it). */
export function cameraPreview(stream: MediaStream): HTMLVideoElement {
  const preview = document.createElement('video');
  preview.srcObject = stream;
  preview.muted = true;
  preview.playsInline = true;
  void preview.play().catch(() => undefined); // autoplay of a muted stream is fine to fail
  return preview;
}

export async function startWebcamRecording(opts: { width?: number; height?: number } = {}): Promise<WebcamSession> {
  const stream = await openCamera(opts);

  const preview = cameraPreview(stream);

  const mime = pickMime();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error(`Video recording is not supported in this browser: ${(err as Error)?.message ?? String(err)}`);
  }

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('Recording failed mid-way.'));
  });
  recorder.start(250);
  const startedAt = performance.now();

  const cleanup = () => {
    for (const t of stream.getTracks()) t.stop();
    preview.srcObject = null;
  };

  return {
    preview,
    startedAt,
    stop: async () => {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      cleanup();
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'video/webm' });
      return { blob, url: URL.createObjectURL(blob) };
    },
    abort: () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // already stopped
      }
      cleanup();
    },
  };
}
