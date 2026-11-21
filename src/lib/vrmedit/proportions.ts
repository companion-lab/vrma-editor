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

// --- VRoid-style body shape (semantic sliders) ---
// Named parameters that compose several bone behaviours into one slider, the
// way VRoid Studio's body tab works (height, arm length, shoulder width…).
// They are applied as a second pass on top of the per-bone boneScale map and
// share its compensation conventions, so the export stays identical.

export const BODY_SHAPE_MIN = 0.5;
export const BODY_SHAPE_MAX = 1.5;

export type BodyShapeParam =
  | 'height' | 'headSize' | 'neckThickness' | 'shoulderWidth' | 'bodyThickness'
  | 'chestSize' | 'belly' | 'hipsWidth' | 'armLength' | 'armThickness'
  | 'handSize' | 'legLength' | 'legThickness' | 'footSize';

/** Sliders in VRoid Studio's body-tab order. */
export const BODY_SHAPE_PARAMS: { param: BodyShapeParam; label: string }[] = [
  { param: 'height', label: 'Height' },
  { param: 'headSize', label: 'Head size' },
  { param: 'neckThickness', label: 'Neck thickness' },
  { param: 'shoulderWidth', label: 'Shoulder width' },
  { param: 'bodyThickness', label: 'Body thickness' },
  { param: 'chestSize', label: 'Chest size' },
  { param: 'belly', label: 'Belly' },
  { param: 'hipsWidth', label: 'Hips' },
  { param: 'armLength', label: 'Arm length' },
  { param: 'armThickness', label: 'Arm thickness' },
  { param: 'handSize', label: 'Hand size' },
  { param: 'legLength', label: 'Leg length' },
  { param: 'legThickness', label: 'Leg thickness' },
  { param: 'footSize', label: 'Foot size' },
];

/** Girth bones per parameter — the thicken pattern (length axis untouched). */
export const BODY_SHAPE_GIRTH: Partial<Record<BodyShapeParam, string[]>> = {
  neckThickness: ['neck'],
  bodyThickness: ['spine', 'chest', 'upperChest'],
  chestSize: ['upperChest', 'chest'],
  belly: ['spine'],
  hipsWidth: ['hips'],
  armThickness: ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'],
  legThickness: ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'],
};

/** Whole-part uniform-scale bones per parameter (head/hands/feet/shoulders). */
export const BODY_SHAPE_UNIFORM: Partial<Record<BodyShapeParam, string[]>> = {
  headSize: ['head'],
  shoulderWidth: ['leftShoulder', 'rightShoulder'],
  handSize: ['leftHand', 'rightHand'],
  footSize: ['leftFoot', 'rightFoot'],
};

/** Bones whose LENGTH axis scales per parameter. */
export const BODY_SHAPE_LENGTH: Partial<Record<BodyShapeParam, string[]>> = {
  height: ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'spine', 'chest', 'upperChest', 'neck'],
  armLength: ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'],
  legLength: ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'],
};

/** The length factor one parameter contributes to one of its length bones.
 *  Height lengthens the legs fully and the torso half as much (VRoid-style
 *  stature), everything else applies its factor uniformly. */
export function bodyShapeLengthFactor(param: BodyShapeParam, value: number, bone: string): number {
  if (param === 'height') {
    const isLeg = bone.includes('Leg');
    return isLeg ? value : 1 + (value - 1) * 0.5;
  }
  return value;
}

/** The legs' composed length factor (height × leg length) — drives the hips
 *  lift that keeps the feet planted when the legs grow. */
export function legLengthFactor(bodyShape: Record<string, number>): number {
  const h = bodyShape.height ?? 1;
  const l = bodyShape.legLength ?? 1;
  return h * l;
}
