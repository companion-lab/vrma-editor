// Viewport skeleton overlay: x-ray joints + bone links built from the
// normalized humanoid rig (the same nodes the editor animates and the gizmo
// targets). Kept as a separate scene group — never parented into vrm.scene —
// so model load/dispose cycles can't touch it.
//
// Instances are re-positioned every frame from the bone nodes' world
// matrices, so the overlay follows playback, scrubbing and gizmo dragging
// automatically.

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { getNormNode } from './animation';
import { resolveParent } from './humanoid';
import type { PosKey, RotKey } from './vrma/parse';

const COLOR_DEFAULT = new THREE.Color(0x9fd8ff);
const COLOR_SELECTED = new THREE.Color(0xffa640);
const COLOR_KEYED = new THREE.Color(0x3ddc97);

const JOINT_RADIUS = 0.012;
const SMALL_JOINT_RADIUS = 0.005; // fingers / toes
const LINK_RADIUS = 0.0035;

// Finger and toe segments get the small joint treatment.
const SMALL_BONE_RE = /(?:Thumb|Index|Middle|Ring|Little)(?:Proximal|Intermediate|Distal)$|Toes$/;

/** The slice of editor state the overlay reads each frame. */
export interface SkeletonOverlayState {
  selectedBones: readonly string[];
  rotTracks: Partial<Record<string, RotKey[]>>;
  hipsTrack: PosKey[];
}

interface LinkDef {
  parent: number; // joint index
  child: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const TMP_M = new THREE.Matrix4();
const TMP_Q = new THREE.Quaternion();
const TMP_S = new THREE.Vector3();
const TMP_V = new THREE.Vector3();
const TMP_V2 = new THREE.Vector3();
const NDC = new THREE.Vector2();
const RAY = new THREE.Raycaster();
const KEYED_TMP = new Set<string>();

export class SkeletonOverlay {
  readonly group = new THREE.Group();

  private jointGeom = new THREE.SphereGeometry(1, 12, 8);
  private linkGeom = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
  private jointMat = new THREE.MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private linkMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  private joints: THREE.InstancedMesh | null = null;
  private links: THREE.InstancedMesh | null = null;
  private jointNodes: THREE.Object3D[] = [];
  private jointBones: string[] = [];
  private jointRadii: number[] = [];
  private positions: THREE.Vector3[] = [];
  private linkDefs: LinkDef[] = [];

  constructor() {
    this.group.matrixAutoUpdate = false;
    this.setVisible(false);
  }

  /** Rebuild for a model. Only bones with a normalized node are shown. */
  build(vrm: VRM) {
    this.clearMeshes();
    const humanoid = vrm.humanoid;
    if (!humanoid) return;

    const nodes = new Map<string, THREE.Object3D>();
    for (const bone of Object.keys(humanoid.humanBones)) {
      const node = getNormNode(vrm, bone);
      if (node) nodes.set(bone, node);
    }
    const bones = [...nodes.keys()];
    if (bones.length === 0) return;

    // Joints: one instance per humanoid bone.
    this.jointBones = bones;
    this.jointNodes = bones.map((b) => nodes.get(b)!);
    this.jointRadii = bones.map((b) => (SMALL_BONE_RE.test(b) ? SMALL_JOINT_RADIUS : JOINT_RADIUS));
    this.positions = bones.map(() => new THREE.Vector3());
    this.joints = new THREE.InstancedMesh(this.jointGeom, this.jointMat, bones.length);
    this.joints.renderOrder = 991;
    this.joints.frustumCulled = false;
    for (let i = 0; i < bones.length; i++) this.joints.setColorAt(i, COLOR_DEFAULT);

    // Links: joint → joint along the resolved parent chain (falls back to the
    // closest existing ancestor when a model lacks intermediate bones).
    const available = new Set(bones);
    this.linkDefs = [];
    for (let i = 0; i < bones.length; i++) {
      const parent = resolveParent(bones[i], available);
      if (parent == null) continue;
      this.linkDefs.push({ parent: bones.indexOf(parent), child: i });
    }
    if (this.linkDefs.length > 0) {
      this.links = new THREE.InstancedMesh(this.linkGeom, this.linkMat, this.linkDefs.length);
      this.links.renderOrder = 990;
      this.links.frustumCulled = false;
      this.group.add(this.links);
    }
    this.group.add(this.joints);
  }

  /** Remove the instanced meshes (keeps shared geometry/materials alive). */
  clearMeshes() {
    if (this.joints) {
      this.group.remove(this.joints);
      this.joints.dispose();
      this.joints = null;
    }
    if (this.links) {
      this.group.remove(this.links);
      this.links.dispose();
      this.links = null;
    }
    this.jointNodes = [];
    this.jointBones = [];
    this.jointRadii = [];
    this.positions = [];
    this.linkDefs = [];
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  /** Re-position joints/links from the current bone world matrices. */
  update(st: SkeletonOverlayState) {
    if (!this.joints || !this.group.visible) return;

    const keyed = KEYED_TMP;
    keyed.clear();
    for (const [bone, keys] of Object.entries(st.rotTracks)) {
      if (keys && keys.length > 0) keyed.add(bone);
    }
    if (st.hipsTrack.length > 0) keyed.add('hips');

    for (let i = 0; i < this.jointNodes.length; i++) {
      const p = this.positions[i];
      this.jointNodes[i].getWorldPosition(p);
      TMP_M.compose(p, TMP_Q.identity(), TMP_S.setScalar(this.jointRadii[i]));
      this.joints.setMatrixAt(i, TMP_M);
      const bone = this.jointBones[i];
      const color = st.selectedBones.includes(bone)
        ? COLOR_SELECTED
        : keyed.has(bone)
          ? COLOR_KEYED
          : COLOR_DEFAULT;
      this.joints.setColorAt(i, color);
    }
    this.joints.instanceMatrix.needsUpdate = true;
    if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true;

    if (this.links) {
      for (let i = 0; i < this.linkDefs.length; i++) {
        const a = this.positions[this.linkDefs[i].parent];
        const b = this.positions[this.linkDefs[i].child];
        TMP_V.subVectors(b, a);
        const len = TMP_V.length();
        if (len > 1e-6) {
          TMP_Q.setFromUnitVectors(UP, TMP_V.multiplyScalar(1 / len));
          TMP_M.compose(
            TMP_V2.addVectors(a, b).multiplyScalar(0.5),
            TMP_Q,
            TMP_S.set(LINK_RADIUS, len, LINK_RADIUS),
          );
        } else {
          TMP_M.makeScale(0, 0, 0); // coincident joints — hide the link
        }
        this.links.setMatrixAt(i, TMP_M);
      }
      this.links.instanceMatrix.needsUpdate = true;
    }
  }

  /** Raycast the visible joints; returns the bone name or null. */
  raycast(ndcX: number, ndcY: number, camera: THREE.Camera): string | null {
    if (!this.joints || !this.group.visible) return null;
    // Instance matrices move every frame — drop the cached bounds so the
    // raycast tests against the current pose.
    this.joints.boundingSphere = null;
    RAY.setFromCamera(NDC.set(ndcX, ndcY), camera);
    const hit = RAY.intersectObject(this.joints, false)[0];
    if (!hit || hit.instanceId == null) return null;
    return this.jointBones[hit.instanceId] ?? null;
  }

  dispose() {
    this.clearMeshes();
    this.jointGeom.dispose();
    this.linkGeom.dispose();
    this.jointMat.dispose();
    this.linkMat.dispose();
    this.group.removeFromParent();
  }
}
