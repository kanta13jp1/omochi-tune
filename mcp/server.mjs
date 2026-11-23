import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOmochiMcpServer, resolveDefaultDashboardHtml } from './core.mjs';
import { startHttpServer } from './http.mjs';
import { createRepoOps } from './ops.mjs';
import { createFileRepositoryStore } from './store.mjs';

const MAX_HTML_BYTES = 10 * 1024 * 1024;

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    transport: 'stdio',
    host: process.env.OMOCHI_TUNE_MCP_HOST?.trim() || '127.0.0.1',
    port: Number(process.env.OMOCHI_TUNE_MCP_PORT || '8788') || 8788,
    repo: undefined,
    html: undefined
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--transport' && argv[i + 1]) {
      opts.transport = argv[++i];
    } else if (arg.startsWith('--transport=')) {
      opts.transport = arg.slice('--transport='.length);
    } else if (arg === '--host' && argv[i + 1]) {
      opts.host = argv[++i];
    } else if (arg.startsWith('--host=')) {
      opts.host = arg.slice('--host='.length);
    } else if (arg === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      opts.port = Number(arg.slice('--port='.length));
    } else if (arg === '--repo' && argv[i + 1]) {
      opts.repo = argv[++i];
    } else if (arg.startsWith('--repo=')) {
      opts.repo = arg.slice('--repo='.length);
    } else if (arg === '--html' && argv[i + 1]) {
      opts.html = argv[++i];
    } else if (arg.startsWith('--html=')) {
      opts.html = arg.slice('--html='.length);
    }
  }

  if (opts.transport !== 'stdio' && opts.transport !== 'http') {
    throw new Error(`Invalid --transport value: ${opts.transport} (expected stdio or http)`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`Invalid --port value: ${opts.port}`);
  }
  return opts;
}

function findRepoRootFrom(startDir) {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, 'content', 'settings.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveRepoRoot(explicitRepo) {
  if (explicitRepo) return resolve(explicitRepo);
  if (process.env.OMOCHI_TUNE_REPO_ROOT?.trim()) {
    return resolve(process.env.OMOCHI_TUNE_REPO_ROOT.trim());
  }
  const fromScript = findRepoRootFrom(dirname(fileURLToPath(import.meta.url)));
  if (fromScript) return fromScript;
  const fromCwd = findRepoRootFrom(process.cwd());
  if (fromCwd) return fromCwd;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function createHtmlLoader(explicitHtmlPath, repoRoot) {
  return () => {
    const candidates = [
      explicitHtmlPath,
      process.env.OMOCHI_TUNE_MCP_HTML?.trim(),
      join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html'),
      join(repoRoot, 'mcp', 'dist', 'dashboard.html'),
      join(repoRoot, '.agents', 'plugins', 'omochi-tune-mcp', 'bin', 'dashboard.html')
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const buf = readFileSync(candidate);
        if (buf.byteLength === 0 || buf.byteLength >= MAX_HTML_BYTES) {
          throw new Error(`dashboard.html のサイズが範囲外です: ${buf.byteLength} bytes`);
        }
        return buf.toString('utf8');
      }
    }
    return resolveDefaultDashboardHtml(explicitHtmlPath);
  };
}

const opts = parseArgs();
const repoRoot = resolveRepoRoot(opts.repo);
const store = createFileRepositoryStore(repoRoot);
const ops = createRepoOps(repoRoot);
const getDashboardHtml = createHtmlLoader(opts.html, repoRoot);

if (opts.transport === 'http') {
  const token = process.env.OMOCHI_TUNE_MCP_HTTP_TOKEN;
  const handle = await startHttpServer({
    createServer: () => createOmochiMcpServer({ store, ops, getDashboardHtml }),
    host: opts.host,
    port: opts.port,
    token
  });

  const shutdownHttp = async () => {
    await handle.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdownHttp);
  process.on('SIGTERM', shutdownHttp);

  console.error(`[omochi-tune-mcp] Streamable HTTP ready at ${handle.endpointUrl} (repo: ${repoRoot})`);
} else {
  const server = createOmochiMcpServer({ store, ops, getDashboardHtml });
  const transport = new StdioServerTransport();

  const shutdownStdio = async () => {
    try {
      await server.close();
    } catch (err) {
      console.error('[omochi-tune-mcp] close error:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdownStdio);
  process.on('SIGTERM', shutdownStdio);

  await server.connect(transport);
  console.error(`[omochi-tune-mcp] stdio server ready (repo: ${repoRoot})`);
}
