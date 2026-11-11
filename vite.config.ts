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
          // Watchdog: reply with an error if the editor never answers.
          setTimeout(() => {
            if (pending.get(cid) === ws) {
              pending.delete(cid);
              send(ws, { __cid: cid, id, ok: false, error: 'Editor did not respond in time' });
            }
          }, 60000);
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

// `assets/` (which contains demo.glb) is served as the public dir,
// so the demo model is reachable at /demo.glb without duplicating it.
export default defineConfig({
  plugins: [react(), listAssets(), aiBridge()],
  publicDir: 'assets',
  server: {
    port: 5173,
  },
});
