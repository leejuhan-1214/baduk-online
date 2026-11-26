import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import './build.mjs';

const require = createRequire(import.meta.url);
const { Miniflare } = require(process.env.BADUK_MINIFLARE || 'miniflare');
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = await readFile(path.join(root, 'dist/server/index.js'), 'utf8');
const types = { html: 'text/html; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const dev = new Miniflare({
  host: '127.0.0.1', port: Number(process.env.BADUK_PORT || 4189),
  modulesRoot: root, compatibilityDate: '2026-04-01',
  d1Databases: ['DB'], d1Persist: path.join(root, '.baduk-data'),
  modules: [
    {
      type: 'ESModule', path: path.join(root, 'development.js'),
      contents: `import worker from './worker.js';
        export default { fetch(req, env, ctx) {
          const p = new URL(req.url).pathname;
          return p === '/ws' || p === '/health' || p.startsWith('/api/') ? worker.fetch(req, env, ctx) : env.UI.fetch(req);
        }};`,
    },
    { type: 'ESModule', path: path.join(root, 'worker.js'), contents: worker },
  ],
  serviceBindings: {
    UI: async req => {
      const filename = new URL(req.url).pathname.slice(1) || 'index.html';
      if (!/^[a-z][\w-]*\.(?:html|mjs|css)$/.test(filename)) return new Response('Not found', { status: 404 });
      const body = await readFile(path.join(root, 'docs', filename)).catch(() => null);
      return body ? new Response(body, { headers: { 'Content-Type': types[filename.split('.').pop()] } }) : new Response('Not found', { status: 404 });
    },
  },
});
const db = await dev.getD1Database('DB');
const schema = await readFile(path.join(root, 'drizzle/0000_baduk.sql'), 'utf8');
for (const sql of schema.split('--> statement-breakpoint')) await db.prepare(sql.trim()).run();
console.log('수담기원 ' + await dev.ready);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await dev.dispose(); process.exit(0); });
