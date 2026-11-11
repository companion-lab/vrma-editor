# AI integration

The editor has built-in AI support so an LLM can create animations and edit the
model. Two ways to use it:

1. **In-app assistant** (primary) — a chat panel inside the editor. The page
   itself talks to any OpenAI-compatible LLM endpoint and drives the editor
   through tools. No other software needed.
2. **MCP server** (optional) — a standalone stdio server (`mcp/server.mjs`)
   that exposes the exact same tools to any MCP client (ZCode, Claude Desktop,
   MCP Inspector, …). Useful if you'd rather prompt from your own AI client.

Both share one tool layer (`src/lib/ai/toolDefs.ts` + `execute.ts`), which runs
in the editor page — tools always execute where the model and the store live.

---

## 1. In-app assistant

### Setup

1. Run the editor: `npm run dev`, open http://localhost:5173.
2. Click the **robot icon** in the toolbar (or the **AI** tab in the right panel).
3. Open **⚙ Settings** in the panel and configure:
   - **Endpoint** — any OpenAI-compatible base URL:
     | Provider | Endpoint | Example model |
     |---|---|---|
     | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
     | GLM (Z.ai) | `https://api.z.ai/api/paas/v4` | `glm-4.6` |
     | OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
     | Ollama (local) | `http://localhost:11434/v1` | `llama3.2` |
     | LM Studio (local) | `http://localhost:1234/v1` | `local-model` |
   - **Model** name, **API key** (stored in this browser's localStorage only —
     leave empty for local endpoints).
   - **Send screenshots to the model** — lets vision models look at the
     viewport to check their own poses (recommended; disable for text-only
     models).
4. Ask for something: *“wave both arms for 2 seconds”*, *“make the jacket
   red”*, *“crouch and then jump”*, *“hide the boots”*.

The assistant shows every tool call it makes (expandable), and screenshots it
took inline. **⏹** stops a run mid-way; the eraser clears the conversation.

Note on CORS: browser-side calls need the endpoint to allow them. OpenAI,
OpenRouter and Z.ai do; for Ollama start with `OLLAMA_ORIGINS="*" ollama serve`.

### Example workflow

```
You:   make a jumping animation, 1.5s
AI:    (set_animation with crouch→launch→land→rest keys)
AI:    (set_transport playing, screenshot to verify)
AI:    "Created 'Jump' — 8 keys across hips/legs/arms. Playing it now; the
        landing looks slightly stiff, want me to soften it?"
```

---

## 2. MCP server

`npm run mcp` starts a stdio MCP server that proxies every editor tool. It is
generic — when new tools are added to the editor, they appear automatically.

```bash
npm run dev   # terminal 1 — the editor
npm run mcp   # terminal 2 — the MCP server
```

The editor page must be open (the green dot in the AI panel = bridge
connected). The server logs to **stderr** only; stdout is MCP protocol.

### Client configuration

ZCode / Claude Code (project-scoped, `.mcp.json` in the repo):

```json
{
  "mcpServers": {
    "vrm-editor": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp/server.mjs"]
    }
  }
}
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "vrm-editor": {
      "command": "node",
      "args": ["/absolute/path/to/vrm editor/mcp/server.mjs"]
    }
  }
}
```

Env overrides: `VRM_EDITOR_WS` (relay URL, default
`ws://localhost:5173/__ai_bridge?role=mcp`).

Try it without a client: `npx @modelcontextprotocol/inspector node mcp/server.mjs`.

---

## Tool reference

32 tools. Everything below errors helpfully when no model is loaded.

| Tool | What it does |
|---|---|
| `get_state` | Model, animation summary, transport, edit counts, meta |
| `list_bones` | Depth-first humanoid bones with parent/key counts |
| `list_materials` | Materials + current edit state |
| `list_assets` | Clothes/hair parts (mesh + per-primitive) with hidden state |
| `list_expressions` | Expression names + current/baked/edited weights |
| `list_models` | Model library files (`assets/models`) |
| `list_outfits` | Saved outfit presets for the model |
| `get_animation` | Full animation JSON (`VrmaData`) |
| `set_animation` | Replace the whole animation with one JSON object |
| `new_animation` | Empty animation, optional name/duration |
| `add_rotation_key` | Key one bone's rotation (euler degrees or quaternion) |
| `add_hips_key` | Key hips position (offset from rest) |
| `clear_track` | Delete all keys of one track |
| `move_key` / `set_key_ease` / `set_track_ease` | Retiming & transitions |
| `set_transport` | time / playing / loop / autoKey / duration / snap / name |
| `reset_pose`, `undo`, `redo` | Pose & history |
| `set_material` / `reset_material` | Color, emissive, opacity, alphaMode, doubleSided |
| `set_visibility` | Hide/show meshes and parts |
| `set_expression` | Expression weight 0..1 |
| `set_bone_scale` | Proportions (uniform factor per body part) |
| `set_meta` | Model meta fields (author, title, license…) |
| `apply_outfit` / `save_outfit` | Saved visibility presets |
| `load_model` | Switch model from the library |
| `export_animation` | Download the current animation as `.vrma` |
| `save_model` | Download the edited model as `.vrm` |
| `screenshot` | Render the viewport, return a PNG data URL |

## Authoring semantics (for prompting and for `set_animation` JSON)

- **Rotations** are relative to **T-pose** (the rest pose with arms out). Keys
  store quaternions `[x,y,z,w]` in canonical space where identity `[0,0,0,1]`
  = T-pose. `add_rotation_key` accepts euler **degrees** `[x,y,z]` (YXZ order,
  same as the pose sliders) and converts.
- **Frame of reference** (verified against the spec reference implementation):
  the model faces the default camera — its **right side appears on the left of
  the screen**. `+X` = screen right (the model's *left*), `+Y` = up, `+Z` =
  toward the camera. Left/right limbs mirror each other's X/Z signs.
  Verified examples: `rightUpperArm [0,0,-75]` raises the right arm
  sideways-up, `leftUpperArm [0,0,75]` raises the left; `head [10,0,0]` nods
  down; `rightUpperLeg [-30,0,0]` raises the right knee forward;
  `rightUpperLeg [0,0,-20]` lifts the right leg outward.
- **Hips position** keys are stored in canonical space, `y ≈ restHipsY` when
  standing. `add_hips_key` takes an **offset** in meters from the standing
  rest pose (`[0,-0.2,0]` ≈ crouch 20 cm; `[-0.3,0,0]` steps to the model's
  right). X/Z are mirrored automatically for VRM 0.x models.
- **Timing**: keys are seconds. If a tool gets a `time`, the playhead moves
  there first and the value is snapped to the current snap setting
  (default 1/30 s). Transitions (`ease`: linear/in/out/inout/step/custom)
  describe the velocity *leaving* a key toward the next one.
- **VRM 0.x quirks** (quaternion/hips mirroring) are handled internally —
  author in canonical space and it just works.
- A compact full animation looks like:

```json
{
  "name": "Jump",
  "duration": 1.5,
  "restHipsY": 1.0,
  "rotTracks": {
    "rightUpperLeg": [
      { "t": 0,    "q": [0,0,0,1] },
      { "t": 0.25, "q": [0,0,0.30,0.95], "ease": "out" },
      { "t": 0.75, "q": [0,0,0,1] }
    ]
  },
  "hipsTrack": [
    { "t": 0,    "p": [0, 1.0, 0],   "ease": "in" },
    { "t": 0.25, "p": [0, 0.85, 0],  "ease": "out" },
    { "t": 0.7,  "p": [0, 1.25, 0],  "ease": "in" },
    { "t": 1.1,  "p": [0, 0.95, 0],  "ease": "out" },
    { "t": 1.5,  "p": [0, 1.0, 0] }
  ]
}
```

## Architecture

```
┌─ browser page (the editor) ─────────────────────────────┐
│  AIPanel ⇄ agent.ts ⇄ executeTool ⇄ store / three.js    │
│      ↑ (also) bridge.ts (role=editor)                   │
└──────────────┬───────────────────────────────────────────┘
               │ ws://localhost:5173/__ai_bridge
│  aiBridge() relay in vite.config.ts (dev server)        │
└──────────────┬───────────────────────────────────────────┘
               │ role=mcp
       mcp/server.mjs (stdio) ⇄ any MCP client
```

- Tools are defined **once** in `src/lib/ai/toolDefs.ts` and executed **once**
  in `src/lib/ai/execute.ts`.
- The assistant calls `executeTool` directly; the MCP path relays through the
  dev server's WS bridge — same executor either way.
- The bridge only exists while `npm run dev` runs (it lives in the Vite dev
  server); in a static build the MCP server reports the editor as offline.
