import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { useEditor } from '../store';
import { applyPose, clearManipulated, getNormNode } from '../lib/animation';
import { SkeletonOverlay } from '../lib/skeleton';
import { parseGlb } from '../lib/vrmedit/glb';
import { bakedExpressionsFromJson, metaFieldsFor } from '../lib/vrmedit/exportModel';
import { applyAllEdits, collectMaterials, snapshotMaterials, stripOutlineSuffix } from '../lib/vrmedit/live';
import { registerPartAssociations } from '../lib/vrmedit/parts';
import { registerViewport } from '../lib/ai/sceneRef';

export function Viewport() {
  const mountRef = useRef<HTMLDivElement>(null);
  const modelUrl = useEditor((s) => s.modelUrl);

  // --- scene bootstrap (once) ---
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    orbit: OrbitControls;
    gizmo: TransformControls;
    gizmoHelper: THREE.Object3D;
    vrmRoot: THREE.Group;
    clock: THREE.Clock;
    overlay: SkeletonOverlay;
  } | null>(null);

  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0e13);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 1.35, 2.6);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.15));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(1, 2, 1.5);
    scene.add(dir);

    const grid = new THREE.GridHelper(10, 20, 0x3a3d4a, 0x23252e);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    scene.add(grid);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 1.0, 0);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.1;

    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setMode('rotate');
    gizmo.setSpace('local');
    gizmo.setSize(0.75);
    const gizmoHelper = (gizmo as any).getHelper?.() ?? (gizmo as unknown as THREE.Object3D);
    scene.add(gizmoHelper);

    const vrmRoot = new THREE.Group();
    scene.add(vrmRoot);

    const overlay = new SkeletonOverlay();
    overlay.setVisible(useEditor.getState().showSkeleton);
    scene.add(overlay.group);

    const clock = new THREE.Clock();
    sceneRef.current = { scene, camera, renderer, orbit, gizmo, gizmoHelper, vrmRoot, clock, overlay };
    registerViewport({ renderer, scene, camera }); // for AI tools (screenshot)
    if (import.meta.env.DEV) {
      (window as any).__vp = { scene, camera, renderer, vrmRoot, grid, overlay };
    }

    // --- render / playback loop ---
    // rAF is suspended in some occluded/offscreen webviews, so a watchdog
    // interval keeps rendering alive in that case.
    let raf = 0;
    let lastRender = 0;
    const tick = () => {
      lastRender = performance.now();
      const st = useEditor.getState();
      const vrm = st.vrm;
      const dt = clock.getDelta();

      if (vrm) {
        if (st.playing) {
          let t = st.time + dt;
          if (t >= st.duration) {
            if (st.loop) t %= st.duration;
            else {
              t = st.duration;
              st.setPlaying(false);
            }
          }
          st.setTime(t);
        }
        applyPose(vrm, st.getAnimData(), st.time, st.restHipsPos, st.animRestHipsY);
        vrm.update(dt);
      }
      overlay.update(st);
      orbit.update();
      renderer.render(scene, camera);
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      tick();
    };
    loop();
    const watchdog = setInterval(() => {
      if (performance.now() - lastRender > 120) tick();
    }, 50);

    // --- click-to-select on skeleton joints ---
    // A clean (non-drag) left click raycasts the joint spheres; shift/ctrl
    // adds to the multi-selection, like the bone tree.
    let downX = 0;
    let downY = 0;
    let downLeft = false;
    let gizmoDragged = false;
    const markGizmoDrag = (e: any) => {
      if (e.value) gizmoDragged = true;
    };
    gizmo.addEventListener('dragging-changed', markGizmoDrag);
    const onPointerDown = (e: PointerEvent) => {
      downLeft = e.button === 0;
      gizmoDragged = false;
      downX = e.clientX;
      downY = e.clientY;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!downLeft || e.button !== 0) return;
      downLeft = false;
      if (gizmoDragged) return; // the click finished a gizmo drag
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
      const el = renderer.domElement;
      const rect = el.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        return;
      }
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const bone = overlay.raycast(ndcX, ndcY, camera);
      if (!bone) return;
      const st = useEditor.getState();
      if (e.shiftKey || e.ctrlKey || e.metaKey) st.toggleBoneSelection(bone);
      else st.selectBone(bone);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
      ro.disconnect();
      gizmo.removeEventListener('dragging-changed', markGizmoDrag);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      gizmo.dispose();
      orbit.dispose();
      overlay.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, []);

  // --- gizmo wiring ---
  useEffect(() => {
    const refs = sceneRef.current;
    if (!refs) return;
    const { gizmo, orbit } = refs;

    const onObjectChange = () => {
      const st = useEditor.getState();
      const bone = st.selectedBone;
      if (!bone) return;
      const node = st.vrm ? getNormNode(st.vrm, bone) : null;
      if (node) {
        node.quaternion.normalize();
        st.manipulateBone(bone, 'rot');
      }
    };
    const onDragging = (e: any) => {
      orbit.enabled = !e.value;
      const st = useEditor.getState();
      if (e.value) {
        if (st.autoKey) st.pushHistory();
      } else {
        // Keep the manually posed bone as-is after release: it stays exempt
        // from pose sampling until the playhead time changes. (Clearing the
        // set here made unkeyed bones snap back to T-pose on mouse-up.)
        st.bumpPose();
      }
    };
    gizmo.addEventListener('objectChange', onObjectChange);
    gizmo.addEventListener('dragging-changed', onDragging);
    return () => {
      gizmo.removeEventListener('objectChange', onObjectChange);
      gizmo.removeEventListener('dragging-changed', onDragging);
    };
  }, []);

  // --- attach gizmo to selected bone ---
  const selectedBone = useEditor((s) => s.selectedBone);
  const vrm = useEditor((s) => s.vrm);
  const showSkeleton = useEditor((s) => s.showSkeleton);
  useEffect(() => {
    const refs = sceneRef.current;
    if (!refs) return;
    if (!vrm || !selectedBone) {
      refs.gizmo.detach();
      return;
    }
    const node = getNormNode(vrm, selectedBone);
    if (node) refs.gizmo.attach(node);
    else refs.gizmo.detach();
  }, [selectedBone, vrm]);

  // --- skeleton overlay: rebuild with the model, follow the toggle ---
  useEffect(() => {
    const refs = sceneRef.current;
    if (!refs) return;
    if (vrm) refs.overlay.build(vrm);
    else refs.overlay.clearMeshes();
  }, [vrm]);
  useEffect(() => {
    sceneRef.current?.overlay.setVisible(showSkeleton);
  }, [showSkeleton]);

  // --- model loading ---
  useEffect(() => {
    if (!modelUrl) return;
    let disposed = false;
    let currentVrm: VRM | null = null;
    const refs = sceneRef.current;

    useEditor.getState().setModelLoading(true);

    const onGltf = (gltf: {
      userData: { vrm?: VRM };
      scene: THREE.Group;
      parser: {
        associations: Map<unknown, { meshes?: number; primitives?: number; materials?: number; nodes?: number }>;
      };
    }) => {
      if (disposed || !refs) return;
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) {
        useEditor.getState().setModelLoading(false);
        useEditor.getState().setStatus('error', 'Not a VRM file (no humanoid found)');
        return;
      }
      currentVrm = vrm;
      if (import.meta.env.DEV) {
        (window as any).__vp && ((window as any).__vp.vrm = vrm);
        (window as any).__vp && ((window as any).__vp.parser = gltf.parser);
      }
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm);

      refs.vrmRoot.clear();
      refs.vrmRoot.add(vrm.scene);

      // frame camera on the model
      const bbox = new THREE.Box3().setFromObject(vrm.scene);
      const height = Math.max(bbox.max.y - bbox.min.y, 0.5);
      const center = bbox.getCenter(new THREE.Vector3());
      refs.orbit.target.set(0, center.y * 1.02, 0);
      refs.camera.position.set(0.35, center.y + height * 0.18, height * 2.15);
      refs.orbit.update();

      const restHips = getNormNode(vrm, 'hips')?.position.clone() ?? new THREE.Vector3();
      clearManipulated();
      snapshotMaterials(vrm);

      // Exact glTF index maps for the model editor's export (three.js names
      // are sanitized/unique-ified, so name matching alone is not reliable).
      const materialIndexByName: Record<string, number> = {};
      for (const m of collectMaterials(vrm)) {
        const base = stripOutlineSuffix(m.name);
        const ref = gltf.parser.associations.get(m);
        if (ref?.materials != null && materialIndexByName[base] == null) {
          materialIndexByName[base] = ref.materials;
        }
      }
      const meshNodeIndicesByName: Record<string, number[]> = {};
      vrm.scene.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        const ref = gltf.parser.associations.get(o);
        if (!ref) return;
        // Single-primitive nodes carry `nodes` directly; primitive children of
        // a multi-primitive mesh find it on their parent group. (glTF has no
        // per-primitive visibility — hiding one primitive exports as hiding
        // the whole mesh.)
        let nodeIndex = ref.nodes;
        if (nodeIndex == null) {
          for (let p = o.parent; p && nodeIndex == null; p = p.parent) {
            nodeIndex = gltf.parser.associations.get(p)?.nodes;
          }
        }
        if (nodeIndex != null) {
          const list = (meshNodeIndicesByName[o.name] ??= []);
          if (!list.includes(nodeIndex)) list.push(nodeIndex);
        }
      });

      const st = useEditor.getState();
      st.setVrm(vrm, restHips, st.modelName);
      st.setModelAssociations({ materialIndexByName, meshNodeIndicesByName });
      // Primitive child → glTF mesh/primitive mapping for the Assets (parts) editor.
      registerPartAssociations(vrm, gltf.parser.associations);

      // Re-apply the last used outfit for this model, if any.
      const lastOutfit = st.outfitsFor().last;
      if (lastOutfit && st.applyOutfit(lastOutfit)) {
        applyAllEdits(vrm, useEditor.getState().modelEdits);
        st.setStatus('info', `Applied outfit "${lastOutfit}"`);
      }
      // Show the file's baked expression weights (three-vrm zeroes rest morph
      // influences, so re-apply them through the expression manager).
      for (const [name, weight] of Object.entries(st.modelBakedExpressions)) {
        vrm.expressionManager?.setValue(name, weight);
      }
      st.setStatus('ok', `Loaded ${st.modelName} — ${Object.keys(vrm.humanoid?.humanBones ?? {}).length} humanoid bones`);
    };

    const onError = (err: unknown) => {
      if (disposed) return;
      console.error(err);
      useEditor.getState().setModelLoading(false);
      useEditor.getState().setStatus('error', 'Failed to load model');
    };

    (async () => {
      try {
        const res = await fetch(modelUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching model`);
        const buf = await res.arrayBuffer();
        if (disposed) return;

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));

        if (buf.byteLength > 12 && new DataView(buf).getUint32(0, true) === 0x46546c67) {
          // GLB: cache the original bytes + meta for the model editor / export,
          // then parse the same buffer.
          try {
            const { json } = parseGlb(buf);
            const st = useEditor.getState();
            st.setOriginalModelBytes(buf);
            st.setModelMeta({
              fields: metaFieldsFor(json),
              values: (json.extensions?.VRMC_vrm?.meta ?? json.extensions?.VRM?.meta ?? {}) as Record<
                string,
                string
              >,
            });
            st.setModelBakedExpressions(bakedExpressionsFromJson(json));
          } catch {
            useEditor.getState().setOriginalModelBytes(null);
            useEditor.getState().setModelMeta(null);
            useEditor.getState().setModelBakedExpressions({});
          }
          loader.parse(buf, '', onGltf, onError);
        } else {
          // Plain .gltf (JSON + external buffers): let the loader fetch it.
          useEditor.getState().setOriginalModelBytes(null);
          useEditor.getState().setModelMeta(null);
          loader.load(modelUrl, onGltf, undefined, onError);
        }
      } catch (err) {
        onError(err);
      }
    })();

    return () => {
      disposed = true;
      if (currentVrm) {
        VRMUtils.deepDispose(currentVrm.scene);
      }
      refs?.vrmRoot.clear();
    };
  }, [modelUrl]);

  return (
    <div className="viewport-wrap">
      <div ref={mountRef} className="viewport" />
      <ModelLoadingOverlay />
      <div className="viewport-hint">
        Orbit: drag · Pan: right-drag · Rotate bone: gizmo / sliders · Key: <b>K</b> · Play: <b>Space</b> · Click bone: select
      </div>
    </div>
  );
}

function ModelLoadingOverlay() {
  const loading = useEditor((s) => s.modelLoading);
  if (!loading) return null;
  return <div className="viewport-overlay">Loading model…</div>;
}
