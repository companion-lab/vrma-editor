// AI tool catalog — the single source of truth for every tool the AI can call.
// Consumed twice:
//  - the in-app assistant (agent.ts converts these to OpenAI-style tool defs)
//  - the MCP bridge (the page serves this list to mcp/server.mjs over WS)
// `inputSchema` is plain JSON Schema (MCP wire format; OpenAI-compatible too).

import { BONE_PARENTS, BONE_ORDER } from '../humanoid';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const BONE_LIST = BONE_ORDER.join(', ');

const obj = (
  description: string,
  properties: ToolDef['inputSchema']['properties'],
  required: string[] = [],
): ToolDef => ({ name: '', description, inputSchema: { type: 'object', properties, required } });

// --- Introspection ---

const getState = obj(
  'Get the current editor state: loaded model, animation summary (name, duration, playhead, key counts per track), transport flags, model-edit counts and the rest hips height. Call this first to understand what you are working with.',
  {},
);

const listBones = obj(
  `List the humanoid bones of the loaded model in depth-first order, with parent, keyframe count and a hasNode flag. Bones without a node cannot be keyed. Canonical bone names include: ${BONE_LIST} (plus finger bones when the rig has them).`,
  {},
);

const listMaterials = obj(
  'List the model materials with their current edit state. Material names are the glTF names (MToon "(Outline)" duplicates are already stripped). Use set_material to change one.',
  {},
);

const listAssets = obj(
  'List the model\'s clothing/hair/face assets: whole-mesh entries and per-primitive parts of merged meshes, each with label, category (top/bottom/feet/underwear/hair/face/body/accessory/other), id and current hidden state. Use set_visibility to hide/show.',
  {},
);

const listExpressions = obj(
  'List the model expressions (blendshapes) with current weight (0..1), the weight baked into the file, any pending edit, and the number of animation keys. Use set_expression to change the rest face, add_expression_key to animate one.',
  {},
);

const listModels = obj(
  'List the models available in the editor library (assets/models folder). Use load_model to switch.',
  {},
);

const listOutfits = obj(
  'List the saved outfit presets for the current model (visibility snapshots). Use apply_outfit to switch.',
  {},
);

// --- Animation ---

const getAnimation = obj(
  'Get the full animation as JSON: { name, duration, restHipsY, rotTracks: { bone: [{id, t, q:[x,y,z,w], ease?}] }, hipsTrack: [{id, t, p:[x,y,z], ease?}], exprTracks: { expression: [{id, t, w, ease?}] } }. q is the bone rotation in canonical VRMA space where T-pose = identity [0,0,0,1]; p is the hips position in canonical space (y ≈ restHipsY when standing at rest); w is an expression weight 0..1.',
  {},
);

const setAnimation = obj(
  'Replace the whole animation with a JSON animation object (same shape get_animation returns). Use this to author a complete animation in one step. Provide name, duration, restHipsY (use get_state restHipsY of the current model) and tracks. Key ids are optional (auto-assigned when omitted).',
  {
    animation: {
      type: 'object',
      description:
        'Animation object: { name: string, duration: number, restHipsY: number, rotTracks?: { boneName: [{ t, euler:[x,y,z] or q:[x,y,z,w], ease? }] }, hipsTrack?: [{ t, p:[x,y,z], ease? }], exprTracks?: { expressionName: [{ t, w: 0..1, ease? }] } }. Prefer euler (canonical degrees, YXZ — same convention as add_rotation_key) over hand-computed quaternions. Expression names come from list_expressions.',
    },
  },
  ['animation'],
);

const newAnimation = obj(
  'Start a new empty animation (clears all keyframes, one undo step). Optionally rename it and set the duration in seconds.',
  {
    name: { type: 'string', description: 'New animation name' },
    duration: { type: 'number', description: 'Duration in seconds (min 0.1)' },
  },
);

const addRotationKey = obj(
  `Add/update a rotation keyframe for one bone. Rotation is relative to T-pose and given either as euler degrees [x,y,z] (YXZ order, matching the pose sliders) or a quaternion [x,y,z,w] in canonical space where identity = T-pose. Frame: the model faces the default camera — its RIGHT side appears on the LEFT of the screen; +X = screen right (the model's left), +Y up, +Z toward the camera. Verified examples: rightUpperArm [0,0,-75] raises the right arm sideways-up, leftUpperArm [0,0,75] raises the left; head [10,0,0] nods down; rightUpperLeg [-30,0,0] raises the right knee forward; rightUpperLeg [0,0,-20] lifts the right leg outward. If 'time' is given, the playhead moves there first (snapped to the current snap setting); otherwise the key goes at the current playhead. Without euler/quaternion the key captures the bone's current live pose (like pressing K).`,
  {
    bone: { type: 'string', description: `Canonical bone name, e.g. rightUpperArm. Full list via list_bones.` },
    time: { type: 'number', description: 'Key time in seconds (clamped to duration). Omit to key at the current playhead.' },
    euler: {
      type: 'array',
      description: 'Rotation in degrees [x, y, z] relative to T-pose (YXZ order, like the pose sliders).',
      items: { type: 'number' },
    },
    quaternion: {
      type: 'array',
      description: 'Alternative to euler: quaternion [x, y, z, w] in canonical space (T-pose = [0,0,0,1]).',
      items: { type: 'number' },
    },
    ease: { type: 'string', description: "Transition curve leaving this key toward the next: 'linear' | 'in' | 'out' | 'inout' | 'step' | 'custom'" },
    capture: { type: 'boolean', description: 'Capture the bone current live pose instead of supplying a rotation.' },
  },
  ['bone'],
);

const addHipsKey = obj(
  `Add/update a hips position keyframe. Position is given as an offset [dx, dy, dz] in meters from the standing rest pose in canonical animation space: +X moves toward the model's LEFT (screen right), +Y up, +Z toward the camera. Examples: crouch ~0.2m = [0, -0.2, 0]; step to the model's right = [-0.3, 0, 0]. If 'time' is given the playhead moves there first; otherwise keys at the current playhead. Without offset/pos it captures the live hips position.`,
  {
    time: { type: 'number', description: 'Key time in seconds. Omit to key at the current playhead.' },
    offset: {
      type: 'array',
      description: 'Offset from rest in meters [dx, dy, dz].',
      items: { type: 'number' },
    },
    pos: {
      type: 'array',
      description: 'Alternative: absolute canonical hips position [x, y, z] (y ≈ restHipsY at rest).',
      items: { type: 'number' },
    },
    ease: { type: 'string', description: "Transition curve toward the next key." },
  },
);

const addExpressionKey = obj(
  `Add/update an expression (blendshape) keyframe so the face animates on the timeline (e.g. happy 1 at t=0 and happy 0 at t=0.5 for a quick smile). Weight is 0..1; if omitted the key captures the expression's current live weight. If 'time' is given the playhead moves there first (snapped); otherwise keys at the current playhead. For a permanent rest-face change use set_expression instead.`,
  {
    name: { type: 'string', description: 'Expression name from list_expressions (e.g. happy, blink, aa)' },
    weight: { type: 'number', description: '0..1. Omit to key the current live weight.' },
    time: { type: 'number', description: 'Key time in seconds. Omit to key at the current playhead.' },
    ease: { type: 'string', description: "Transition curve leaving this key toward the next: 'linear' | 'in' | 'out' | 'inout' | 'step' | 'custom'" },
  },
  ['name'],
);

const clearTrack = obj(
  "Delete every keyframe of one track. track is a bone name, '__hips__' for the hips position track, or 'expr:<name>' for an expression track (e.g. 'expr:happy').",
  { track: { type: 'string', description: "Bone name, '__hips__', or 'expr:<name>'" } },
  ['track'],
);

const moveKey = obj(
  'Move one keyframe to a new time (snapped). Get ids from get_animation.',
  {
    track: { type: 'string', description: "Bone name, '__hips__', or 'expr:<name>'" },
    keyId: { type: 'number', description: 'Key id from get_animation' },
    time: { type: 'number', description: 'New time in seconds' },
  },
  ['track', 'keyId', 'time'],
);

const setKeyEase = obj(
  "Set the transition curve of one keyframe. ease: 'linear' | 'in' | 'out' | 'inout' | 'step' | 'custom'. For 'custom' pass bez [x1,y1,x2,y2] (CSS cubic-bezier style).",
  {
    track: { type: 'string', description: "Bone name, '__hips__', or 'expr:<name>'" },
    keyId: { type: 'number' },
    ease: { type: 'string' },
    bez: { type: 'array', description: 'Custom bezier handles [x1,y1,x2,y2] when ease=custom', items: { type: 'number' } },
  },
  ['track', 'keyId', 'ease'],
);

const setTrackEase = obj(
  'Apply one transition curve to every keyframe of a track.',
  {
    track: { type: 'string', description: "Bone name, '__hips__', or 'expr:<name>'" },
    ease: { type: 'string' },
  },
  ['track', 'ease'],
);

const setTransport = obj(
  'Change the transport / playback state: move the playhead (time), play/pause, loop, autoKey (keying while posing), duration, snap interval in seconds (0 = off) or rename the animation.',
  {
    time: { type: 'number', description: 'Playhead time in seconds' },
    playing: { type: 'boolean' },
    loop: { type: 'boolean' },
    autoKey: { type: 'boolean' },
    duration: { type: 'number', description: 'Animation duration in seconds (min 0.1)' },
    snap: { type: 'number', description: 'Snap interval in seconds, 0 = off (e.g. 1/30 ≈ 0.0333)' },
    name: { type: 'string', description: 'Rename the animation' },
  },
);

const resetPose = obj(
  'Reset the whole model to T-pose (does not touch keyframes).',
  {},
);

const undoTool = obj('Undo the last animation or model edit (one step).', {});
const redoTool = obj('Redo a previously undone animation or model edit (one step).', {});

// --- Motion reference (video) ---

const getMotionVideoInfo = obj(
  'Get info about the motion-reference video the user loaded with the "Motion video…" toolbar button: file name, duration in seconds, pixel dimensions. Errors with a hint when no video is loaded — in that case just tell the user to load one; there is no way for you to open a video yourself.',
  {},
);

const extractMotionFromVideo = obj(
  'Extract human motion from the loaded motion-reference video as the current animation. Runs in-browser pose tracking (MediaPipe) frame by frame, retargets the tracked person onto the humanoid rig and imports the result as the whole animation (one undo step, starts playing). The video must be loaded first (see get_motion_video_info). Long videos are processed in ≤60s chunks automatically, but keep segments short anyway (start/end) — long spans are slow and the result replaces the timeline. Afterwards review the returned warnings (low coverage, sparse tracks) and refine: set_track_ease smoothing, clear_track for noisy tracks, get_animation/screenshot to inspect. Expect a REFERENCE-quality result: tracking noise, no finger/hand data, hips forward/backward travel is not recoverable from monocular video (vertical bob and lateral sway are).',
  {
    fps: {
      type: 'number',
      description: 'Sampling rate in frames per second, 5-30 (default 15). Lower is faster and stays smooth via interpolation; use 30 only for fast motion.',
    },
    start: { type: 'number', description: 'Segment start in seconds (default 0).' },
    end: { type: 'number', description: 'Segment end in seconds (default video duration; max span 60s).' },
    smooth: {
      type: 'number',
      description: 'Smoothing window in frames per side, 0-10 (default 2). Higher = smoother but lags fast motion.',
    },
    import: {
      type: 'boolean',
      description: 'Import the result into the timeline (default true). When false, only a summary is returned.',
    },
  },
);

// --- Model editing ---

const setMaterial = obj(
  'Edit a material: base color and/or emissive as "#rrggbb" hex, opacity 0..1, alphaMode OPAQUE/MASK/BLEND, doubleSided. The change previews immediately and is baked in when the model is saved.',
  {
    name: { type: 'string', description: 'Material name from list_materials' },
    color: { type: 'string', description: 'Base color hex, e.g. "#ff3366"' },
    emissive: { type: 'string', description: 'Emissive color hex' },
    opacity: { type: 'number', description: '0..1' },
    alphaMode: { type: 'string', description: "'OPAQUE' | 'MASK' | 'BLEND'" },
    doubleSided: { type: 'boolean' },
  },
  ['name'],
);

const resetMaterial = obj(
  'Restore a material to its original look and drop its edit.',
  { name: { type: 'string' } },
  ['name'],
);

const setVisibility = obj(
  'Hide/show assets (clothes, hair, props…). Pass mesh ids (whole meshes) and/or part ids ("meshIndex:primitiveIndex" of merged meshes) from list_assets with hidden true/false.',
  {
    hideMeshes: { type: 'array', items: { type: 'string' }, description: 'Whole-mesh ids to hide' },
    showMeshes: { type: 'array', items: { type: 'string' }, description: 'Whole-mesh ids to show' },
    hideParts: { type: 'array', items: { type: 'string' }, description: 'Part ids to hide' },
    showParts: { type: 'array', items: { type: 'string' }, description: 'Part ids to show' },
  },
);

const setExpression = obj(
  'Set a static expression weight 0..1 (e.g. happy, angry, aa, blink) — the rest face, applied immediately and baked into the model on save. To animate an expression over time on the timeline, use add_expression_key instead.',
  {
    name: { type: 'string', description: 'Expression name from list_expressions' },
    weight: { type: 'number', description: '0..1' },
  },
  ['name', 'weight'],
);

const setBoneScale = obj(
  'Scale a body part proportionally (uniform factor, 1 = original). Bones: head, neck, upperChest, chest, spine, hips, shoulders, arms (upper/lower), hands, legs (upper/lower), feet — left/right prefixed. Adjacent segments compose cleanly. Baked into the model on save.',
  {
    bone: { type: 'string', description: 'e.g. head, leftUpperArm, rightUpperLeg' },
    factor: { type: 'number', description: 'Uniform scale factor, 1 = unchanged (e.g. 1.2 = +20%)' },
  },
  ['bone', 'factor'],
);

const setMeta = obj(
  'Edit a model meta field (author name, title, license…). Fields depend on the VRM version — see get_state.',
  {
    field: { type: 'string' },
    value: { type: 'string', description: 'New value; empty string clears the field' },
  },
  ['field', 'value'],
);

const applyOutfit = obj(
  'Apply a saved outfit preset (visibility snapshot) for the current model.',
  { name: { type: 'string' } },
  ['name'],
);

const saveOutfit = obj(
  'Snapshot the current clothes/asset visibility as a named outfit preset for this model.',
  { name: { type: 'string' } },
  ['name'],
);

// --- Model & files ---

const loadModel = obj(
  'Load a model from the library by file name (see list_models). Waits until the model is loaded and returns its bone count.',
  { name: { type: 'string', description: 'Library file name, e.g. "myavatar.vrm"' } },
  ['name'],
);

const exportAnimation = obj(
  'Export the current animation as a .vrma file (browser download). Nothing happens when the animation has no keyframes.',
  {},
);

const saveModel = obj(
  'Download the model as .vrm with all current edits (materials, hidden parts, expressions, proportions, meta) baked in.',
  {},
);

const screenshot = obj(
  'Render the viewport right now and return a PNG (data URL). Use it to visually check poses/results. The image is also shown in the chat.',
  {},
);

// --- Catalog ---

function named(def: ReturnType<typeof obj>, name: string): ToolDef {
  return { name, description: def.description, inputSchema: def.inputSchema };
}

export const TOOL_DEFS: ToolDef[] = [
  named(getState, 'get_state'),
  named(listBones, 'list_bones'),
  named(listMaterials, 'list_materials'),
  named(listAssets, 'list_assets'),
  named(listExpressions, 'list_expressions'),
  named(listModels, 'list_models'),
  named(listOutfits, 'list_outfits'),
  named(getAnimation, 'get_animation'),
  named(setAnimation, 'set_animation'),
  named(newAnimation, 'new_animation'),
  named(addRotationKey, 'add_rotation_key'),
  named(addHipsKey, 'add_hips_key'),
  named(addExpressionKey, 'add_expression_key'),
  named(clearTrack, 'clear_track'),
  named(moveKey, 'move_key'),
  named(setKeyEase, 'set_key_ease'),
  named(setTrackEase, 'set_track_ease'),
  named(setTransport, 'set_transport'),
  named(resetPose, 'reset_pose'),
  named(undoTool, 'undo'),
  named(redoTool, 'redo'),
  named(getMotionVideoInfo, 'get_motion_video_info'),
  named(extractMotionFromVideo, 'extract_motion_from_video'),
  named(setMaterial, 'set_material'),
  named(resetMaterial, 'reset_material'),
  named(setVisibility, 'set_visibility'),
  named(setExpression, 'set_expression'),
  named(setBoneScale, 'set_bone_scale'),
  named(setMeta, 'set_meta'),
  named(applyOutfit, 'apply_outfit'),
  named(saveOutfit, 'save_outfit'),
  named(loadModel, 'load_model'),
  named(exportAnimation, 'export_animation'),
  named(saveModel, 'save_model'),
  named(screenshot, 'screenshot'),
];

// Static context for prompts/docs: canonical bone hierarchy.
export { BONE_PARENTS, BONE_ORDER };
