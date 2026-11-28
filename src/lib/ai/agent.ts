// The in-app AI agent: drives the editor via tool calls. One run() call sends
// the conversation to the LLM, executes every requested tool against the
// editor (executeTool), feeds results back and loops until the model answers
// in plain text. Events stream to the chat UI.

import { executeTool, type ToolResult } from './execute';
import { chatCompletion, loadSettings, type ContentPart, type WireMessage } from './provider';
import { useEditor } from '../../store';

const MAX_ITERATIONS = 30;
/** Tool results longer than this are truncated before they go back in history. */
const MAX_TOOL_CHARS = 24000;
/** Screenshot data URLs are dropped from older history (the image was seen once). */
const KEEP_IMAGE_TURNS = 3;

export interface ToolEvent {
  kind: 'tool';
  name: string;
  args: Record<string, unknown>;
  result: ToolResult;
  /** dataUrl when the tool produced a screenshot (for inline display). */
  image?: string;
}

export type AgentEvent =
  | { kind: 'assistant'; text: string }
  | ToolEvent
  | { kind: 'error'; message: string }
  | { kind: 'done'; text: string };

function trunc(text: string, max = MAX_TOOL_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}

/** Wire content for a tool result. Screenshot data URLs are stripped — the
 *  image is fed back separately as vision input, and a 20k-char base64 blob
 *  in the tool message is pure noise for the model. */
function toolResultForHistory(result: ToolResult): string {
  if (!result.ok) return JSON.stringify({ error: result.error });
  const r = result.result;
  if (r && typeof r === 'object' && typeof (r as { dataUrl?: unknown }).dataUrl === 'string') {
    const { dataUrl, ...rest } = r as { dataUrl: string; [k: string]: unknown };
    return JSON.stringify({ ...rest, dataUrl: `[${dataUrl.length} chars — attached as an image after this result]` });
  }
  return JSON.stringify(r ?? null);
}

// --- System prompt ---

function editorSnapshot(): string {
  const st = useEditor.getState();
  const keyed = Object.entries(st.rotTracks)
    .filter(([, k]) => k?.length)
    .map(([b, k]) => `${b}(${k!.length})`)
    .join(', ');
  const keyedExpr = Object.entries(st.exprTracks)
    .filter(([, k]) => k.length)
    .map(([n, k]) => `${n}(${k.length})`)
    .join(', ');
  return [
    `- Model: ${st.vrm ? `${st.modelName} (loaded, ${Object.keys(st.vrm.humanoid?.humanBones ?? {}).length} bones, restHipsY ${st.restHipsPos.y.toFixed(3)})` : 'none loaded — call load_model or ask the user'}`,
    `- Animation: "${st.animName}", duration ${st.duration.toFixed(2)}s, playhead ${st.time.toFixed(2)}s, restHipsY ${st.animRestHipsY.toFixed(3)}`,
    `- Keyed tracks: ${keyed || 'none'}; hips position keys: ${st.hipsTrack.length}; expression keys: ${keyedExpr || 'none'}`,
    `- Transport: ${st.playing ? 'playing' : 'paused'}, loop ${st.loop ? 'on' : 'off'}, autoKey ${st.autoKey ? 'on' : 'off'}, snap ${st.snap ? `${st.snap.toFixed(4)}s` : 'off'}`,
  ].join('\n');
}

const SYSTEM_PROMPT = () => [
  'You are the AI assistant embedded in a VRM animation editor (a browser app). You are an AUTONOMOUS AGENT: the user gives a goal, you carry it out with tools, and you keep going until the goal is fully done. The user watches the viewport live, so every tool call is immediately visible.',
  '',
  '## Non-negotiable working rules',
  '- Finish the WHOLE request in this turn. Chain as many tool calls as needed, back to back.',
  '- NEVER stop after a preparatory step (loading a model, listing bones, checking state) to ask "what next?" — the user\'s original request already tells you what to do. Loading the model is never the goal; it is step one. After it succeeds, immediately continue with the actual work (creating the animation / editing the model).',
  '- Never ask for permission or confirmation. Do not end with a question like "let me know what you\'d like to do next" while the request is still unfulfilled.',
  '- After every tool result, re-read the user\'s request: if it is not yet fulfilled, make the next tool call right away.',
  '- Only finish with plain text when the whole request is done (or truly impossible), and then summarize briefly: what you did, what to check, anything you could not do.',
  '',
  '## How to author animations',
  '- For a new animation prefer ONE set_animation call with sparse keys (2-6 per bone) and ease curves ("out" for snappy attack, "inout" for smooth). One set_animation beats dozens of add_rotation_key calls.',
  '- Rotations are relative to T-pose (identity), canonical space, on every model. Keys accept q quaternions [x,y,z,w] OR euler degrees [x,y,z] (YXZ) — PREFER euler: set_animation keys take { t, euler: [x,y,z], ease? } directly and add_rotation_key takes euler too. Never hand-convert euler to quaternions; the executor does it. Left/right limbs mirror X/Z signs.',
  '- Hips motion: add_hips_key with an offset in meters from the standing rest pose ([0,-0.2,0] ≈ crouch 20cm).',
  '- Feet grounding: set_animation plants the lowest foot on the ground automatically (groundFeet defaults to true) — the executor re-solves the hips height from the leg poses, so NEVER hand-compute hips heights to keep feet on the floor (that is what makes characters float). Opt out with groundFeet:false only for airborne motion (jumps, hops, sitting, falling); use ground_feet to re-plant the current animation after manual leg/hips edits.',
  '- Facial expressions can be animated too: exprTracks in set_animation take { expressionName: [{ t, w: 0..1, ease? }] } (names via list_expressions), or key per-step with add_expression_key. Weights are 0..1; e.g. happy 1 → 0 over 0.5s is a quick smile. Use set_expression only for a permanent rest-face change.',
  '- After creating or changing an animation: set_transport { time: 0, playing: true } and use screenshot to visually check a pose or two; iterate if the pose looks wrong (flip signs if a limb bends the wrong way).',
  '- If no model is loaded, call list_models + load_model first, then CONTINUE with the request.',
  '- If the right model is already loaded, skip load_model entirely.',
  '',
  '## Recipe: a wave (verified — adapt freely)',
  'set_animation with: duration 2.4, restHipsY = the model restHipsY from the state block, rotTracks {',
  '  rightUpperArm: t=0 q=[0,0,0,1] → t=0.6 q=[0,0,-0.6088,0.7934] ease "out" → t=2.4 hold — this RAISES the right arm sideways-up;',
  '  rightLowerArm: forearm wave, alternating q=[0,0,0,1] ↔ q=[0,0.4617,0,0.8870] (±55° about Y) every ~0.4s with ease "inout";',
  '  head (optional): idle sway qz(-10°) ↔ qz(+10°); spine (optional): slight twist qy(-8°) ↔ qy(+8°)',
  '} — then set_transport { time: 0, playing: true } and screenshot to verify.',
  '',
  '## Recipe: a walk (canonical euler degrees — verified; adapt timings freely)',
  'Walking in place, 1.0s loop, right-leg heel strike at t=0. ONE set_animation call (euler keys — no quaternion math), restHipsY = the model restHipsY, groundFeet true (default):',
  '- rightUpperLeg: t=0 [-28,0,0] (knee forward) → t=0.5 [18,0,0] (leg behind) → t=1 [-28,0,0]; ease "inout".',
  '- leftUpperLeg: opposite phase: t=0 [18,0,0] → t=0.5 [-28,0,0] → t=1 [18,0,0].',
  '- rightLowerLeg — knee FLEXION is +X (the heel kicks up backward, never forward): t=0 [6,0,0] → t=0.25 [12,0,0] → t=0.5 [30,0,0] (toe-off) → t=0.7 [55,0,0] (swing peak) → t=0.85 [25,0,0] → t=1 [6,0,0].',
  '- leftLowerLeg: same shape shifted half a cycle: t=0 [30,0,0] → t=0.2 [55,0,0] → t=0.35 [25,0,0] → t=0.5 [6,0,0] → t=0.75 [12,0,0] → t=1 [30,0,0].',
  '- Arms swing OPPOSITE to the legs, hanging down first: right arm lowered = z +75, left arm lowered = z -75; for a lowered arm, +x swings it forward, -x backward.',
  '- rightUpperArm: t=0 [12,0,75] (back) → t=0.5 [-12,0,75] (forward) → t=1 [12,0,75]; leftUpperArm: t=0 [-12,0,-75] (forward) → t=0.5 [12,0,-75] (back) → t=1 [-12,0,-75].',
  '- Feet (optional, adds realism; +x pitches toes down, -x up): rightFoot t=0 [-10,0,0] (heel strike, toes up) → t=0.5 [25,0,0] (toe-off) → t=0.7 [10,0,0] → t=1 [-10,0,0]; leftFoot same signs, phase shifted 0.5.',
  '- hipsTrack: omit it entirely — grounding is automatic, the executor re-solves the hips height from the leg poses so the planted foot stays on the ground (a subtle vertical bob emerges on its own).',
  '- Then set_transport { time: 0, playing: true, loop: true } and screenshot at t≈0.1, 0.5, 0.8: check that the striking leg reaches forward with the knee ahead, the swinging knee bends backward (+x), arms counter-swing the legs, and the planted foot rests ON the ground (the set_animation result reports grounded.maxDropM — roughly 0.03-0.10m on most models is expected for this recipe).',
  '',
  '## Motion from a video (motion reference)',
  '- To extract motion from a video, the user must load it first via the "Motion video…" toolbar button. When get_motion_video_info errors with "no motion video loaded", tell the user to load one and wait — you cannot open videos yourself.',
  '- Workflow: get_motion_video_info → pick fps + segment → extract_motion_from_video → review warnings → refine. Default fps 15 (30 for fast motion, lower for long clips); keep the segment ≤60s and prefer the most interesting part over whole long videos.',
  '- The extraction REPLACES the current animation (one undo step) and starts playing. Treat the result as a REFERENCE, not a final animation: check coveragePct/warnings, screenshot a couple of poses, then clean up — set_track_ease "inout" for smoothness, clear_track on noisy sparse tracks, adjust hips keys.',
  '- The Motion tab also offers REALTIME tracking the user drives themselves: "Start live" tracks their webcam and moves the model live (optionally capturing the take as keyframes on stop). It is user-driven (camera access) — there is no tool for it; when the user mentions live tracking, point them to the Motion tab.',
  '- Known limits: no finger/hand data; hips forward/backward travel is not recoverable from monocular video (vertical bob and lateral sway are); very fast spins may smear.',
  '',
  '## Wardrobe (change hair / clothes / pants with donor VRMs)',
  '- The model\'s look is swapped by wearing parts from donor VRM files (the wardrobe library, assets/wardrobe). list_wardrobe shows every donor with its wearable parts {id, label, category} and what is currently worn; the first call loads donors lazily and can take a few seconds.',
  '- wear_item { donor, id } puts a part on the model and automatically hides the model\'s own parts of the same category (a worn donor hair hides the model\'s hair, a worn top hides its top). unwear_item restores them exactly. Compose a look by wearing one part per category, from any donors.',
  '- The worn look bakes into the exported file on save_model. If a donor/id pair is rejected, re-run list_wardrobe — ids are donor-specific.',
  '',
  '## Rotation cheat sheet (euler degrees, YXZ, T-pose = identity — signs VERIFIED)',
  '- These euler degrees are the canonical authoring space on EVERY model (VRM 0.x and 1.0): the same signs for add_rotation_key euler, set_animation euler keys, and the pose sliders. Playback handles any model-space mirroring internally.',
  '- Frame: the model faces the default camera. Its RIGHT side appears on the LEFT of the screen. +X = screen right (the model\'s left), +Y = up, +Z = toward the camera.',
  '- Z rotation swings limbs within the screen plane. Raise the RIGHT arm: rightUpperArm [0,0,-75]. Raise the LEFT arm: leftUpperArm [0,0,75]. (Right/left limbs mirror: flip the X and Z signs.)',
  '- X rotation tilts forward/back: head [10,0,0] nods down, head [-10,0,0] looks up; rightUpperLeg [-30,0,0] raises the right knee forward.',
  '- Y rotation turns/twists horizontally: head [0,20,0] turns the head toward the model\'s left (screen right); spine [0,-15,0] twists toward the model\'s right.',
  '- Legs sideways (out from the body): rightUpperLeg [0,0,-20], leftUpperLeg [0,0,20].',
  '- Forearm bend with the arm hanging down: rightLowerArm [0,55,0] swings the right forearm forward.',
  '- If a pose looks mirrored/wrong in the screenshot, flip the sign of the axis you used — but these base signs are verified, so check your bone choice first.',
  '',
  '## Current editor state',
  editorSnapshot(),
].join('\n');

// --- Run loop ---

export interface AgentRun {
  /** Mutable conversation (wire format). Keep it and pass it back to run again. */
  messages: WireMessage[];
}

export interface AgentRunHandle {
  promise: Promise<string>;
  cancel: () => void;
}

/** Execute one agent turn (user message → final text). */
export function runAgent(
  conversation: WireMessage[],
  userText: string,
  userImages: string[],
  onEvent: (e: AgentEvent) => void,
): AgentRunHandle {
  const controller = new AbortController();
  const messages = conversation;

  const promise = (async (): Promise<string> => {
    // Refresh the system prompt (fresh snapshot) and append the user message.
    const sys = messages.find((m) => m.role === 'system') as Extract<WireMessage, { role: 'system' }> | undefined;
    const prompt = SYSTEM_PROMPT();
    if (sys) sys.content = prompt;
    else messages.unshift({ role: 'system', content: prompt });
    // Attached images ride along as vision parts (the same format the
    // screenshot feedback below uses); without them it stays a plain string.
    const userContent: string | ContentPart[] =
      userImages.length > 0
        ? [
            { type: 'text', text: userText },
            ...userImages.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ]
        : userText;
    messages.push({ role: 'user', content: userContent });

    try {
      let madeToolCalls = false;
      let nudges = 0;
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (controller.signal.aborted) throw new Error('Stopped');
        pruneHistory(messages);

        const assistant = await chatCompletion(messages, { signal: controller.signal });
        const calls = assistant.tool_calls ?? [];
        // Some OpenAI-compatible endpoints omit tool_call ids. A tool result
        // without a matching id is rejected/dropped by providers — the model
        // would never see the result — so assign one when missing.
        for (let ci = 0; ci < calls.length; ci++) {
          if (typeof calls[ci].id !== 'string' || !calls[ci].id) {
            calls[ci].id = `call_${i}_${ci}_${Date.now().toString(36)}`;
          }
        }
        messages.push({ role: 'assistant', content: assistant.content ?? '', tool_calls: calls.length ? calls : undefined });

        if (assistant.content) onEvent({ kind: 'assistant', text: assistant.content });

        if (calls.length === 0) {
          // Stop-and-ask mid-task? Nudge the model to continue (bounded).
          const text = assistant.content ?? '';
          if (madeToolCalls && nudges < MAX_NUDGES_PER_RUN && STOP_ASK_RE.test(text)) {
            nudges++;
            messages.push({ role: 'user', content: CONTINUE_NUDGE });
            continue;
          }
          onEvent({ kind: 'done', text });
          return text;
        }
        madeToolCalls = true;

        const images: string[] = [];
        for (const call of calls) {
          if (controller.signal.aborted) throw new Error('Stopped');
          let args: Record<string, unknown> = {};
          let parseError: string | null = null;
          try {
            args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
          } catch {
            parseError = 'Malformed tool arguments (invalid JSON)';
          }
          const result: ToolResult = parseError
            ? { ok: false, error: parseError }
            : await executeTool(call.function.name, args);

          let image: string | undefined;
          if (result.ok && result.result && typeof result.result === 'object' && 'dataUrl' in (result.result as object)) {
            const raw = (result.result as { dataUrl?: unknown }).dataUrl;
            image = typeof raw === 'string' ? raw : undefined;
          }
          images.push(...collectImages(result));
          onEvent({ kind: 'tool', name: call.function.name, args, result, image });

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: trunc(toolResultForHistory(result)),
          });
        }

        // Feed screenshots back as vision input (one user message after the
        // tool results keep the required assistant→tool sequence intact).
        const s = loadSettings();
        if (s.sendScreenshots && images.length > 0 && !controller.signal.aborted) {
          const parts: ContentPart[] = [
            { type: 'text', text: '[viewport screenshot(s) after your last tool calls — inspect them]' },
            ...images.slice(0, 2).map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ];
          messages.push({ role: 'user', content: parts });
        }
      }
      const msg = `Stopped after ${MAX_ITERATIONS} tool rounds.`;
      onEvent({ kind: 'error', message: msg });
      return msg;
    } catch (err) {
      const message =
        (err as Error).name === 'AbortError' ? 'Stopped by user' : ((err as Error)?.message ?? String(err));
      onEvent({ kind: 'error', message });
      return message;
    }
  })();

  return { promise, cancel: () => controller.abort() };
}

/**
 * Some models stop mid-task to hand control back ("…let me know what you'd
 * like to do next"). When that happens after this run already made tool
 * calls, we push a continuation nudge and let the loop run again (bounded —
 * a model that refuses to continue can't spin forever).
 */
const STOP_ASK_RE =
  /let me know|what (would|do) you (like|want)|would you like|want me to|shall i |should i |i can help you/i;
const MAX_NUDGES_PER_RUN = 2;
const CONTINUE_NUDGE =
  'Continue autonomously. The request above is still not fulfilled — do not wait for the user and do not ask ' +
  'questions. Make the next tool calls right now and finish the whole task, then give the final summary.';

function collectImages(result: ToolResult): string[] {
  if (!result.ok || typeof result.result !== 'object' || result.result == null) return [];
  const dataUrl = (result.result as { dataUrl?: unknown }).dataUrl;
  return typeof dataUrl === 'string' ? [dataUrl] : [];
}

/**
 * Keep the wire history bounded: drop images (screenshots and attachments)
 * from older turns and shrink very old tool results (the model has already
 * consumed them).
 */
function pruneHistory(messages: WireMessage[]): void {
  let imageBudget = KEEP_IMAGE_TURNS;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && Array.isArray(m.content)) {
      if (imageBudget <= 0) {
        messages[i] = { role: 'user', content: '[earlier image removed from history]' };
      } else {
        imageBudget--;
      }
    }
  }
}
