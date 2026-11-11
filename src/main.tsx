import { createRoot } from 'react-dom/client';
import App from './App';
import { useEditor } from './store';
import { manipulatedBones, sampleVec3, applyPose } from './lib/animation';
import { startAiBridge } from './lib/ai/bridge';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

// MCP bridge (dev only): lets mcp/server.mjs drive this editor tab.
startAiBridge();

// Dev/test hooks
if (typeof window !== 'undefined') {
  (window as any).__editor = {
    useEditor,
    manipulated: () => [...manipulatedBones],
    sampleVec3,
    applyPose,
    GLTFLoader: undefined as any,
    refImpl: undefined as any,
    parseVRMA: (buf: ArrayBuffer) => import('./lib/vrma/parse').then((m) => m.parseVRMA(buf)),
    buildVRMA: (data: any) => import('./lib/vrma/build').then((m) => m.buildVRMA(data)),
  };
  // Reference implementation for verifying import/export compatibility.
  Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three'),
    import('@pixiv/three-vrm-animation'),
  ]).then(([gltf, three, ref]) => {
    (window as any).__editor.GLTFLoader = (gltf as any).GLTFLoader;
    (window as any).__editor.THREE = three;
    (window as any).__editor.refImpl = ref;
  });
}
