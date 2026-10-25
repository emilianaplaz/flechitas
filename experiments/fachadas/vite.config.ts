// Vite aparte para el experimento de fachadas. No toca la app: lee las teselas reales de
// ../../public/maqueta (publicDir) y sirve la prueba de video del repo en /prueba/.
// Solo en desarrollo: POST /__captura guarda capturas del canvas en capturas/.
import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repo = resolve(here, '../..');

const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
};

/** Serves a folder of the repo under a URL prefix, read-only, no directory listing. */
function serveDir(prefix: string, dir: string): Plugin {
  return {
    name: `serve-${prefix}`,
    configureServer(server) {
      server.middlewares.use(prefix, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const file = normalize(join(dir, rel));
        if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('content-type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('content-length', String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
  };
}

/** Saves a JPEG/PNG sent by the page (canvas capture) into capturas/<name>. Dev only. */
function capturas(): Plugin {
  const out = join(here, 'capturas');
  return {
    name: 'capturas',
    configureServer(server) {
      server.middlewares.use('/__captura', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('n') ?? '';
        if (req.method !== 'POST' || !/^[a-z0-9-]+\.(jpg|png)$/.test(name)) {
          res.statusCode = 400;
          return res.end('nombre inválido');
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, name), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  root: here,
  publicDir: join(repo, 'public'),
  envDir: here,
  server: { port: 5190, fs: { allow: [repo] } },
  plugins: [serveDir('/prueba', join(repo, 'PRUEBA RENDER')), serveDir('/cache', join(here, '.cache')), capturas()],
});
