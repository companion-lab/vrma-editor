// Canonical humanoid bone hierarchy (VRM 1.0 bone names, also used by VRMA).
// Used for the bone tree UI and for stable export ordering.

export const BONE_PARENTS: Record<string, string> = {
  spine: 'hips',
  chest: 'spine',
  upperChest: 'chest',
  neck: 'upperChest',
  head: 'neck',
  jaw: 'head',
  leftEye: 'head',
  rightEye: 'head',

  leftShoulder: 'upperChest',
  leftUpperArm: 'leftShoulder',
  leftLowerArm: 'leftUpperArm',
  leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest',
  rightUpperArm: 'rightShoulder',
  rightLowerArm: 'rightUpperArm',
  rightHand: 'rightLowerArm',

  leftUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg',
  leftFoot: 'leftLowerLeg',
  leftToes: 'leftFoot',
  rightUpperLeg: 'hips',
  rightLowerLeg: 'rightUpperLeg',
  rightFoot: 'rightLowerLeg',
  rightToes: 'rightFoot',
};

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const SEGMENTS = ['Proximal', 'Intermediate', 'Distal'] as const;

for (const side of ['left', 'right'] as const) {
  BONE_PARENTS[`${side}Toes`] = `${side}Foot`;
  for (const finger of FINGERS) {
    for (const seg of SEGMENTS) {
      const name = `${side}${finger}${seg}`;
      if (seg === 'Proximal') BONE_PARENTS[name] = `${side}Hand`;
      else BONE_PARENTS[name] = `${side}${finger}${SEGMENTS[SEGMENTS.indexOf(seg) - 1]}`;
    }
  }
}

// Depth-first display order starting from hips.
export const BONE_ORDER: string[] = (() => {
  const order: string[] = [];
  const visit = (name: string) => {
    order.push(name);
    for (const [child, parent] of Object.entries(BONE_PARENTS)) {
      if (parent === name) visit(child);
    }
  };
  visit('hips');
  // Any bone not reachable from hips (shouldn't happen) goes last.
  for (const bone of Object.keys(BONE_PARENTS)) {
    if (!order.includes(bone)) order.push(bone);
  }
  return order;
})();

export const BONE_ORDER_INDEX: Record<string, number> = Object.fromEntries(
  BONE_ORDER.map((b, i) => [b, i]),
);

// Resolve the closest existing ancestor of `bone` among `available`.
export function resolveParent(bone: string, available: Set<string>): string | null {
  let p = BONE_PARENTS[bone];
  while (p) {
    if (available.has(p)) return p;
    p = BONE_PARENTS[p];
  }
  return null;
}

export interface BoneRow {
  name: string;
  depth: number;
}

// Flat depth-first list for rendering the bone tree.
export function buildBoneRows(available: Iterable<string>): BoneRow[] {
  const set = available instanceof Set ? available : new Set(available);
  const childrenOf: Record<string, string[]> = {};
  const roots: string[] = [];
  for (const bone of set) {
    const parent = resolveParent(bone, set);
    if (parent) {
      (childrenOf[parent] ??= []).push(bone);
    } else {
      roots.push(bone);
    }
  }
  const cmp = (a: string, b: string) =>
    (BONE_ORDER_INDEX[a] ?? 999) - (BONE_ORDER_INDEX[b] ?? 999);
  roots.sort(cmp);
  for (const list of Object.values(childrenOf)) list.sort(cmp);

  const rows: BoneRow[] = [];
  const visit = (name: string, depth: number) => {
    rows.push({ name, depth });
    for (const child of childrenOf[name] ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

export function prettyBoneName(name: string): string {
  const side = name.startsWith('left') ? 'L ' : name.startsWith('right') ? 'R ' : '';
  const base = name.replace(/^left|^right/, '');
  return side + base.replace(/([a-z])([A-Z])/g, '$1 $2');
}
