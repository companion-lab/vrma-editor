import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

// Dev-server middleware listing `assets/models/` and `assets/textures/` so the
// editor's model library dropdown and texture picker pick up dropped-in files
// without a restart. Static builds (vite preview / any host) fall back to the
// manifest.json files.
function listAssets(): Plugin {
  const listing = (dir: string, filter: RegExp) => (_req: any, res: any) => {
    let files: string[] = [];
    try {
      files = readdirSync(join(process.cwd(), 'assets', dir)).filter((f) => filter.test(f));
    } catch {
      // folder may not exist yet
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ files }));
  };
  return {
    name: 'list-assets',
    configureServer(server) {
    server.middlewares.use('/api/models', listing('models', /\.(vrm|glb|gltf)$/i));
    server.middlewares.use('/api/textures', listing('textures', /\.(png|jpe?g|webp)$/i));
    server.middlewares.use('/api/wardrobe', listing('wardrobe', /\.(vrm|glb|gltf)$/i));
    },
  };
}

// WS relay between the editor page (role=editor) and AI clients such as the
// standalone MCP server (role=mcp). Clients post { id, cmd, args } requests;
// the relay wraps them with a __cid, forwards to the single connected editor
// and routes the { __cid, id, ok, result|error } response back. Vite's own
// HMR upgrade listener only claims its own protocol/path, so a second upgrade
// handler is safe here.
function aiBridge(): Plugin {
  return {
    name: 'ai-bridge',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
      let editor: WebSocket | null = null;
      const clients = new Set<WebSocket>();
      const pending = new Map<string, WebSocket>();
      let cidSeq = 0;

      server.httpServer?.on('upgrade', (req, socket, head) => {
        const { pathname } = new URL(req.url ?? '/', 'http://localhost');
        if (pathname !== '/__ai_bridge') return;
        wss.handleUpgrade(req, socket as never, head, (ws) => wss.emit('connection', ws, req));
      });

      wss.on('connection', (ws: WebSocket, req: { url?: string }) => {
        const role = new URL(req.url ?? '/', 'http://localhost').searchParams.get('role');

        if (role === 'editor') {
          if (editor && editor !== ws) editor.close(4000, 'replaced by a newer editor tab');
          editor = ws;
          for (const c of clients) send(c, { type: 'editor', connected: true });
          ws.on('close', () => {
            if (editor === ws) {
              editor = null;
              for (const c of clients) send(c, { type: 'editor', connected: false });
            }
          });
        } else {
          clients.add(ws);
          send(ws, { type: 'editor', connected: !!editor });
          ws.on('close', () => clients.delete(ws));
        }

        ws.on('message', (data) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(String(data));
          } catch {
            return;
          }

          if (role === 'editor') {
            // Response from the editor — route it back to the waiting client.
            const cid = typeof msg.__cid === 'string' ? msg.__cid : null;
            const target = cid ? pending.get(cid) : null;
            if (target) {
              pending.delete(cid!);
              send(target, msg);
            }
            return;
          }

          // Request from an AI client — wrap with a correlation id.
          const cid = `c${++cidSeq}`;
          pending.set(cid, ws);
          const id = msg.id;
          if (editor && editor.readyState === ws.OPEN) {
            send(editor, { ...msg, __cid: cid });
          } else {
            send(ws, {
              __cid: cid,
              id,
              ok: false,
              error: 'Editor not connected — open the VRM editor at http://localhost:5173',
            });
            pending.delete(cid);
            return;
          }
          // Watchdog: reply with an error if the editor never answers. Must
          // exceed the MCP client's own timeout (90s) so a slow-but-alive
          // editor (model loading) isn't cut off with a misleading error.
          setTimeout(() => {
            if (pending.get(cid) === ws) {
              pending.delete(cid);
              send(ws, { __cid: cid, id, ok: false, error: 'Editor did not respond in time' });
            }
          }, 120000);
        });
      });

      function send(ws: WebSocket, msg: unknown) {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            // client vanished mid-send
          }
        }
      }
    },
  };
}

// Dev counterpart of api/chat.ts (the Vercel serverless function): relays
// OpenAI-compatible chat completions to the endpoint named in the x-ai-url
// header, so remote providers (no browser CORS) work in dev exactly like in
// the deployed build. Local endpoints (Ollama/LM Studio) bypass it entirely.
function aiChatProxy(): Plugin {
  return {
    name: 'ai-chat-proxy',
    configureServer(server) {
      server.middlewares.use('/api/chat', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        let url: URL;
        try {
          url = new URL(String(req.headers['x-ai-url'] ?? ''));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing or invalid x-ai-url header' }));
          return;
        }
        if (url.protocol !== 'https:') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'x-ai-url must be https' }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', async () => {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          const auth = req.headers.authorization;
          if (typeof auth === 'string' && auth) headers.Authorization = auth;
          try {
            const upstream = await fetch(url, {
              method: 'POST',
              headers,
              body: Buffer.concat(chunks).toString('utf8') || '{}',
            });
            res.statusCode = upstream.status;
            const ct = upstream.headers.get('content-type');
            if (ct) res.setHeader('Content-Type', ct);
            res.end(Buffer.from(await upstream.arrayBuffer()));
          } catch (err) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: `Upstream request failed: ${(err as Error).message}` }));
          }
        });
      });
    },
  };
}

// `assets/` (which contains demo.glb) is served as the public dir,
// so the demo model is reachable at /demo.glb without duplicating it.
export default defineConfig({
  plugins: [react(), listAssets(), aiChatProxy(), aiBridge()],
  publicDir: 'assets',
  server: {
    port: 5173,
  },
  build: {
    // The 3D viewport is the app and renders on first paint, so three.js can't
    // be lazy-loaded away. It is split into a cacheable vendor chunk, but
    // three + @pixiv/three-vrm together are inherently ~1 MB minified.
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'three',
              priority: 20,
              // three + @pixiv/three-vrm*, but NOT three-vrm-animation — it is
              // only loaded lazily in main.tsx (reference impl hook) and must
              // keep its own chunk.
              test: /node_modules[\\/]three[\\/]|node_modules[\\/]@pixiv[\\/]three-vrm(?!-animation)[^\\/]*[\\/]/,
            },
            {
              name: 'vendor',
              priority: 10,
              // Everything else from node_modules, except @mediapipe/tasks-vision
              // which is loaded lazily when mocap starts (lib/mocap/pose.ts).
              test: /node_modules[\\/](?!@mediapipe|@pixiv[\\/]three-vrm-animation)/,
            },
          ],
        },
      },
    },
  },
});
