import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'mcp', 'dist');
const pluginBinDir = path.join(repoRoot, '.agents', 'plugins', 'omochi-tune-mcp', 'bin');

fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(pluginBinDir, { recursive: true });

// 1. Bundle MCP App UI into a single self-contained CSP-safe HTML document.
const uiBuild = await esbuild.build({
  entryPoints: [path.join(repoRoot, 'mcp', 'app', 'main.mjs')],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2023'],
  write: false
});

const uiJs = uiBuild.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const uiCss = fs.readFileSync(path.join(repoRoot, 'mcp', 'app', 'styles.css'), 'utf8');

const html = [
  '<!doctype html>',
  '<html lang="ja">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
  '  <title>OMOCHI TUNE — MCP App</title>',
  '  <style>',
  uiCss,
  '  </style>',
  '</head>',
  '<body>',
  '  <div id="app"></div>',
  '  <script>',
  uiJs,
  '  </script>',
  '</body>',
  '</html>',
  ''
].join('\n');

const htmlBytes = Buffer.byteLength(html, 'utf8');
if (htmlBytes >= 10 * 1024 * 1024) {
  throw new Error(`MCP App HTML exceeds 10 MiB limit (${htmlBytes} bytes)`);
}

const distHtmlPath = path.join(distDir, 'dashboard.html');
fs.writeFileSync(distHtmlPath, html, 'utf8');

// 2. Bundle MCP Server (Stdio + Streamable HTTP) into a standalone ESM artifact.
await esbuild.build({
  entryPoints: [path.join(repoRoot, 'mcp', 'server.mjs')],
  bundle: true,
  platform: 'node',
  target: ['node22'],
  format: 'esm',
  outfile: path.join(distDir, 'server.mjs'),
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __dirnameFn } from "node:path";',
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirnameFn(__filename);'
    ].join('\n')
  }
});

// 3. Sync built artifacts into workspace Antigravity plugin bin/ (and global copy if installed).
for (const targetBinDir of [
  pluginBinDir,
  path.join(os.homedir(), '.gemini', 'config', 'plugins', 'omochi-tune-mcp', 'bin')
]) {
  if (targetBinDir === pluginBinDir || fs.existsSync(path.dirname(targetBinDir))) {
    fs.mkdirSync(targetBinDir, { recursive: true });
    fs.copyFileSync(path.join(distDir, 'server.mjs'), path.join(targetBinDir, 'server.mjs'));
    fs.copyFileSync(distHtmlPath, path.join(targetBinDir, 'dashboard.html'));
  }
}

console.log(
  `Built MCP server (${fs.statSync(path.join(distDir, 'server.mjs')).size} bytes) and MCP App UI (${htmlBytes} bytes)`
);
