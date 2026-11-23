import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOmochiMcpServer } from './core.mjs';
import { createRepoOps } from './ops.mjs';
import { createFileRepositoryStore } from './store.mjs';

function resolveRepoRoot(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) {
      return resolve(argv[i + 1]);
    }
    if (arg.startsWith('--repo=')) {
      return resolve(arg.slice('--repo='.length));
    }
  }
  if (process.env.OMOCHI_TUNE_REPO_ROOT) {
    return resolve(process.env.OMOCHI_TUNE_REPO_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

const repoRoot = resolveRepoRoot();
const store = createFileRepositoryStore(repoRoot);
const ops = createRepoOps(repoRoot);
const server = createOmochiMcpServer({ store, ops });
const transport = new StdioServerTransport();

async function shutdown() {
  try {
    await server.close();
  } catch (err) {
    console.error('[omochi-tune-mcp] close error:', err);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(transport);
console.error(`[omochi-tune-mcp] stdio server ready (repo: ${repoRoot})`);
