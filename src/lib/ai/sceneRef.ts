// Registry for the three.js viewport objects, used by AI tools (screenshot).
// Viewport.tsx fills this once when the scene boots so the AI tool layer can
// reach the renderer without window globals (works in dev and prod builds).

import type { Camera, Scene, WebGLRenderer } from 'three';

export interface ViewportRefs {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
}

let refs: ViewportRefs | null = null;

export function registerViewport(r: ViewportRefs): void {
  refs = r;
}

export function getViewport(): ViewportRefs | null {
  return refs;
}
