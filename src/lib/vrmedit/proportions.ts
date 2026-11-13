// Single source of truth for the proportion (boneScale) feature's
// configuration. Both the live preview (live.ts) and the export bake
// (exportModel.ts) must apply the same bone behaviour — keep every set here
// instead of copying it per file.

// Allowed factor range for the sliders and the AI `set_bone_scale` tool.
export const PROPORTION_MIN = 0.5;
export const PROPORTION_MAX = 1.5;

// Torso & limb bones THICKEN: the two local axes perpendicular to the bone's
// length grow by the factor while the length axis stays at 1, and their
// children are compensated (scale + position on the same two axes) so the part
// fattens in place without displacing or inflating its neighbours. Uniform
// inflation would balloon the flesh along the bone too, stretching it past the
// pinned child joints.
export const THICKEN_BONES = new Set([
  'spine',
  'chest',
  'upperChest',
  'neck',
  'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
  'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg',
]);
// Shoulders: uniform scale with the child's scale divided back — the arm pivots
// outward for broad shoulders while its thickness stays unchanged.
export const COMPENSATE_CHILD_SCALE = new Set(['leftShoulder', 'rightShoulder']);

// Canonical child bone of each thicken bone; the direction to it defines the
// bone's length axis (arms run along local X in T-pose rigs, torso/legs along
// Y). Extra entries are fallbacks for optional bones (upperChest).
export const LENGTH_AXIS_CHILD: Record<string, string[]> = {
  spine: ['chest'], chest: ['upperChest', 'neck'], upperChest: ['neck'], neck: ['head'],
  leftUpperArm: ['leftLowerArm'], rightUpperArm: ['rightLowerArm'],
  leftLowerArm: ['leftHand'], rightLowerArm: ['rightHand'],
  leftUpperLeg: ['leftLowerLeg'], rightUpperLeg: ['rightLowerLeg'],
  leftLowerLeg: ['leftFoot'], rightLowerLeg: ['rightFoot'],
};

// Every bone a proportion slider can scale.
export const EDITABLE_BONES = [
  'head', 'neck', 'chest', 'upperChest', 'spine', 'hips',
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
  'leftHand', 'rightHand',
  'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg',
  'leftFoot', 'rightFoot',
];

// Slider rows shown in the Model panel. Pair groups scale both sides; scalar
// groups drive every listed bone that exists (e.g. Chest thickens chest AND
// upperChest — the child compensation cancels the double-scale, so the whole
// chest region gets one even factor).
export const PROPORTION_GROUPS: { label: string; bones: string[]; pair?: boolean }[] = [
  { label: 'Head', bones: ['head'] },
  { label: 'Neck', bones: ['neck'] },
  { label: 'Chest', bones: ['upperChest', 'chest'] },
  { label: 'Spine', bones: ['spine'] },
  { label: 'Hips (whole body)', bones: ['hips'] },
  { label: 'Shoulders', bones: ['leftShoulder', 'rightShoulder'], pair: true },
  { label: 'Upper arms', bones: ['leftUpperArm', 'rightUpperArm'], pair: true },
  { label: 'Lower arms', bones: ['leftLowerArm', 'rightLowerArm'], pair: true },
  { label: 'Hands', bones: ['leftHand', 'rightHand'], pair: true },
  { label: 'Upper legs', bones: ['leftUpperLeg', 'rightUpperLeg'], pair: true },
  { label: 'Lower legs', bones: ['leftLowerLeg', 'rightLowerLeg'], pair: true },
  { label: 'Feet', bones: ['leftFoot', 'rightFoot'], pair: true },
];
