import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

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

// `assets/` (which contains demo.glb) is served as the public dir,
// so the demo model is reachable at /demo.glb without duplicating it.
export default defineConfig({
  plugins: [react(), listAssets()],
  publicDir: 'assets',
  server: {
    port: 5173,
  },
});
