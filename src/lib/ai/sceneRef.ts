// Registry for the three.js viewport objects, used by AI tools (screenshot)
// and the texture paint mode. Viewport.tsx fills this once when the scene
// boots so other layers can reach the renderer without window globals (works
// in dev and prod builds).

import type { Camera, Scene, WebGLRenderer } from 'three';

// Minimal shape of OrbitControls the paint mode needs (typed structurally to
// avoid importing from three/examples here).
export interface ViewportOrbit {
  mouseButtons: { LEFT?: unknown };
  touches: { ONE?: unknown };
}

export interface ViewportRefs {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  orbit?: ViewportOrbit;
}

let refs: ViewportRefs | null = null;

export function registerViewport(r: ViewportRefs): void {
  refs = r;
}

export function getViewport(): ViewportRefs | null {
  return refs;
}
