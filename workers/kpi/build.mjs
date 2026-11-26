import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './cloudflare.config.ts';

const root = dirname(fileURLToPath(import.meta.url));
const outRoot = join(root, '.cloudflare', 'output', 'v0');
const workerDir = join(outRoot, 'workers', 'default');
const bundleDir = join(workerDir, 'bundle');

await rm(join(root, '.cloudflare'), { recursive: true, force: true });
await mkdir(bundleDir, { recursive: true });

await writeFile(
  join(outRoot, 'config.json'),
  JSON.stringify({ buildContext: { isPreview: false } }, null, 2) + '\n',
  'utf8'
);

const { entrypoint, ...workerConfig } = config.worker;
await writeFile(
  join(workerDir, 'worker.config.json'),
  JSON.stringify(
    {
      ...workerConfig,
      manifest: {
        type: 'complete',
        mainModule: 'index.mjs',
        modules: {
          'index.mjs': { type: 'esm' }
        }
      }
    },
    null,
    2
  ) + '\n',
  'utf8'
);

await copyFile(resolve(root, entrypoint), join(bundleDir, 'index.mjs'));
console.log('Prepared Cloudflare BOS output in', outRoot);
