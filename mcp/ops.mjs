import { execFile } from 'node:child_process';
import { access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getTokyoParts } from './schedule.mjs';

const execFileAsync = promisify(execFile);

const CONTENT_EXACT_PATHS = new Set([
  'content/settings.json',
  'content/columns.json',
  'content/gallery.json',
  'content/tarot.json',
  'content/instagram.json'
]);

const UPLOAD_PATH_RE = /^images\/uploads\/[a-zA-Z0-9._-]+\.(png|jpe?g|webp|gif)$/i;

export function isAllowedPublishPath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return CONTENT_EXACT_PATHS.has(normalized) || UPLOAD_PATH_RE.test(normalized);
}

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runSubprocess(command, args, { cwd, timeoutMs = 60000, encoding = 'utf8' } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      encoding,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
      stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8')
    };
  } catch (err) {
    const stdout = Buffer.isBuffer(err?.stdout) ? err.stdout.toString('utf8') : err?.stdout || '';
    const stderr = Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf8') : err?.stderr || '';
    const detail = [stderr.trim(), stdout.trim(), err?.message].filter(Boolean).join('\n');
    throw new Error(`コマンド実行に失敗しました (${command} ${args.join(' ')}):\n${detail}`);
  }
}

export function parseGitPorcelainZ(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const tokens = text.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const status = token.slice(0, 2);
    const path = token.slice(3).replace(/\\/g, '/');
    let oldPath = null;
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      oldPath = (tokens[i + 1] || '').replace(/\\/g, '/');
      i += 1;
    }
    entries.push({ status, path, oldPath });
  }
  return entries;
}

function validateCommitMessage(message) {
  const trimmed = String(message ?? '').trim();
  if (!trimmed) {
    throw new Error('commitMessage は空にできません');
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('commitMessage は 1 行で指定してください');
  }
  if (trimmed.length > 120) {
    throw new Error('commitMessage は 120 文字以内で指定してください');
  }
  return trimmed;
}

function validateBranchName(branchName) {
  const trimmed = String(branchName ?? '').trim();
  if (!trimmed) {
    throw new Error('branchName が空です');
  }
  if (
    trimmed === 'main' ||
    trimmed.includes('..') ||
    trimmed.includes('//') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    !/^[a-zA-Z0-9._/-]+$/.test(trimmed)
  ) {
    throw new Error(`不正なブランチ名です: ${trimmed}`);
  }
  return trimmed;
}

function defaultPrBranchName(now = new Date()) {
  const p = getTokyoParts(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `content/mcp-${p.year}${pad(p.month)}${pad(p.day)}-${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
}

export function createRepoOps(repoRootInput) {
  const repoRoot = resolve(repoRootInput);

  async function runGit(args, { encoding = 'utf8', timeoutMs = 30000 } = {}) {
    return runSubprocess('git', args, { cwd: repoRoot, encoding, timeoutMs });
  }

  return {
    async runBuild() {
      const buildScript = join(repoRoot, 'scripts', 'build.mjs');
      const { stdout, stderr } = await runSubprocess(process.execPath, [buildScript], {
        cwd: repoRoot,
        timeoutMs: 30000
      });

      const distDir = join(repoRoot, 'dist');
      const requiredOutputs = ['index.html', 'feed.xml', 'sitemap.xml', 'robots.txt'];
      const missingOutputs = [];
      for (const rel of requiredOutputs) {
        if (!(await exists(join(distDir, rel)))) {
          missingOutputs.push(rel);
        }
      }
      if (missingOutputs.length > 0) {
        throw new Error(`ビルド成果物が不足しています: ${missingOutputs.join(', ')}`);
      }

      const leakedDirs = [];
      for (const forbidden of ['mcp', '.agents', 'supabase', 'workers']) {
        if (await exists(join(distDir, forbidden))) {
          leakedDirs.push(forbidden);
        }
      }
      if (leakedDirs.length > 0) {
        throw new Error(`公開ディレクトリ dist/ に不要ファイルが含まれています: ${leakedDirs.join(', ')}`);
      }

      return {
        ok: true,
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
        verifiedFiles: requiredOutputs.map((f) => `dist/${f}`),
        excludedVerified: ['dist/mcp', 'dist/.agents', 'dist/supabase', 'dist/workers']
      };
    },

    async runE2E() {
      const playwrightCli = join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
      if (!(await exists(playwrightCli))) {
        throw new Error('Playwright が未インストールです（npm install を実行してください）');
      }
      const { stdout, stderr } = await runSubprocess(process.execPath, [playwrightCli, 'test'], {
        cwd: repoRoot,
        timeoutMs: 120000
      });
      return {
        ok: true,
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
      };
    },

    async getPublishStatus() {
      const [branchRes, porcelainRes, diffStatRes, logRes] = await Promise.all([
        runGit(['branch', '--show-current']),
        runGit(['status', '--porcelain=v1', '-z', '-uall']),
        runGit(['diff', '--stat', '--', 'content', 'images/uploads']),
        runGit(['log', '-n', '5', '--oneline'])
      ]);

      const entries = parseGitPorcelainZ(porcelainRes.stdout);

      const allowedContentPaths = [];
      const otherPaths = [];
      for (const entry of entries) {
        const allowCurrent = isAllowedPublishPath(entry.path);
        const allowOld = !entry.oldPath || isAllowedPublishPath(entry.oldPath);
        if (allowCurrent && allowOld) {
          allowedContentPaths.push(entry.path);
        } else {
          otherPaths.push(entry.path);
        }
      }

      return {
        currentBranch: branchRes.stdout.trim() || '(detached)',
        allowedContentPaths,
        otherPaths,
        contentDiffStat: diffStatRes.stdout.trim(),
        recentCommits: logRes.stdout
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
      };
    },

    async publishChanges(
      {
        mode = 'pr',
        commitMessage,
        prTitle,
        prBody,
        branchName,
        runValidation = true,
        confirm = false
      },
      validateFn
    ) {
      if (mode !== 'pr' && mode !== 'push_main') {
        throw new Error(`未知の公開モードです: ${mode}（pr または push_main を指定してください）`);
      }

      const cleanCommitMsg = validateCommitMessage(commitMessage);
      const status = await this.getPublishStatus();

      if (status.allowedContentPaths.length === 0) {
        return {
          dryRun: !confirm,
          published: false,
          noChanges: true,
          mode,
          currentBranch: status.currentBranch,
          filesToStage: [],
          ignoredOtherFiles: status.otherPaths,
          message: '公開対象のコンテンツ変更（content/*.json または images/uploads/*）はありません。'
        };
      }

      let buildResult = null;
      if (runValidation !== false) {
        if (typeof validateFn === 'function') {
          await validateFn();
        }
        buildResult = await this.runBuild();
      }

      const targetBranch =
        mode === 'push_main'
          ? 'main'
          : branchName
            ? validateBranchName(branchName)
            : defaultPrBranchName();

      if (confirm !== true) {
        return {
          dryRun: true,
          published: false,
          mode,
          currentBranch: status.currentBranch,
          targetBranch,
          commitMessage: cleanCommitMsg,
          filesToStage: status.allowedContentPaths,
          ignoredOtherFiles: status.otherPaths,
          validationPassed: runValidation !== false,
          buildVerifiedFiles: buildResult?.verifiedFiles || [],
          nextStep:
            '変更内容を確認のうえ、実際に GitHub へ反映する場合は confirm: true を指定して publish_changes を再実行してください。'
        };
      }

      if (status.currentBranch !== 'main') {
        throw new Error(
          `安全な公開のため main ブランチからのみ実行できます（現在のブランチ: ${status.currentBranch}）`
        );
      }

      if (mode === 'pr') {
        try {
          await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`]);
          throw new Error(`ブランチ ${targetBranch} は既に存在します。別の branchName を指定してください`);
        } catch (err) {
          if (err.message.includes('既に存在します')) throw err;
        }
        await runGit(['checkout', '-b', targetBranch]);
      }

      await runGit(['add', '--', ...status.allowedContentPaths]);

      const stagedRes = await runGit(['diff', '--cached', '--name-only']);
      const stagedFiles = stagedRes.stdout
        .trim()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (stagedFiles.length === 0) {
        throw new Error('ステージされた変更が空のためコミットを中止しました');
      }

      await runGit(['commit', '-m', cleanCommitMsg]);
      const shaRes = await runGit(['rev-parse', 'HEAD']);
      const commitSha = shaRes.stdout.trim();

      if (mode === 'push_main') {
        await runGit(['push', 'origin', 'main'], { timeoutMs: 60000 });
        return {
          dryRun: false,
          published: true,
          mode: 'push_main',
          branch: 'main',
          commitSha,
          commitMessage: cleanCommitMsg,
          committedFiles: stagedFiles,
          ignoredOtherFiles: status.otherPaths,
          actionsUrl: 'https://github.com/kanta13jp1/omochi-tune/actions'
        };
      }

      await runGit(['push', '-u', 'origin', targetBranch], { timeoutMs: 60000 });

      const effectiveTitle = String(prTitle || cleanCommitMsg).trim();
      const effectiveBody = String(
        prBody ||
          [
            '## OMOCHI TUNE コンテンツ更新（Antigravity MCP）',
            '',
            '### 更新ファイル',
            ...stagedFiles.map((f) => `- \`${f}\``),
            '',
            '### 検証結果',
            `- 事前スキーマ検証・ビルド確認: ${runValidation !== false ? '実施済み' : 'スキップ'}`
          ].join('\n')
      );

      const tmpBodyPath = join(tmpdir(), `omochi-pr-body-${process.pid}-${Date.now()}.md`);
      try {
        await writeFile(tmpBodyPath, effectiveBody, 'utf8');
        const prRes = await runSubprocess(
          'gh',
          [
            'pr',
            'create',
            '--base',
            'main',
            '--head',
            targetBranch,
            '--title',
            effectiveTitle,
            '--body-file',
            tmpBodyPath
          ],
          { cwd: repoRoot, timeoutMs: 60000 }
        );
        return {
          dryRun: false,
          published: true,
          mode: 'pr',
          branch: targetBranch,
          commitSha,
          commitMessage: cleanCommitMsg,
          committedFiles: stagedFiles,
          ignoredOtherFiles: status.otherPaths,
          prUrl: prRes.stdout.trim()
        };
      } finally {
        await rm(tmpBodyPath, { force: true }).catch(() => {});
      }
    }
  };
}
