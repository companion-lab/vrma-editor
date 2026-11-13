import { createRoot } from 'react-dom/client';
import App from './App';
import { useEditor, makeSampleData } from './store';
import { manipulatedBones, sampleVec3, applyPose } from './lib/animation';
import { startAiBridge } from './lib/ai/bridge';
// Statically imported because the rest of the app already pulls them in —
// dynamic imports here were flagged as INEFFECTIVE_DYNAMIC_IMPORT by rolldown.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { parseVRMA } from './lib/vrma/parse';
import { buildVRMA } from './lib/vrma/build';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

// MCP bridge (dev only): lets mcp/server.mjs drive this editor tab.
startAiBridge();

// Dev/test hooks
if (typeof window !== 'undefined') {
  (window as any).__editor = {
    useEditor,
    makeSampleData,
    manipulated: () => [...manipulatedBones],
    sampleVec3,
    applyPose,
    GLTFLoader,
    THREE,
    refImpl: undefined as any,
    parseVRMA: (buf: ArrayBuffer) => parseVRMA(buf),
    buildVRMA: (data: any) => buildVRMA(data),
  };
  // Reference implementation for verifying import/export compatibility.
  import('@pixiv/three-vrm-animation').then((ref) => {
    (window as any).__editor.refImpl = ref;
  });
}
