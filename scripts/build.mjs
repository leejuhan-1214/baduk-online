import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require(process.env.BADUK_ESBUILD || 'esbuild');
await build({
  entryPoints: [path.join(root, 'server', 'worker.mjs')],
  outfile: path.join(root, 'dist', 'server', 'index.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', charset: 'utf8',
});
const manifest = path.join(root, '.openai', 'hosting.json');
if (await readFile(manifest).then(() => true, () => false)) {
  await mkdir(path.join(root, 'dist', '.openai'), { recursive: true });
  await copyFile(manifest, path.join(root, 'dist', '.openai', 'hosting.json'));
}
