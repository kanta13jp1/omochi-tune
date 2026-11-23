import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { MAX_UPLOAD_BYTES, validateUploadFilename } from './schemas.mjs';

export const CONTENT_FILES = {
  settings: 'content/settings.json',
  columns: 'content/columns.json',
  gallery: 'content/gallery.json',
  tarot: 'content/tarot.json',
  instagram: 'content/instagram.json'
};

async function writeAtomicFile(targetPath, data) {
  await mkdir(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    await writeFile(tmpPath, data);
    try {
      await rename(tmpPath, targetPath);
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EXDEV' || err.code === 'EEXIST')) {
        await writeFile(targetPath, data);
      } else {
        throw err;
      }
    }
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

/**
 * File-system repository store for local stdio mode.
 * Designed behind an explicit interface so a remote GitHub API store can share mcp/core.mjs.
 */
export function createFileRepositoryStore(repoRootInput) {
  const repoRoot = resolve(repoRootInput);
  const contentDir = resolve(repoRoot, 'content');
  const uploadsDir = resolve(repoRoot, 'images', 'uploads');

  function resolveContentPath(key) {
    const rel = CONTENT_FILES[key];
    if (!rel) {
      throw new Error(`未知のコンテンツキーです: ${key}`);
    }
    return resolve(repoRoot, rel);
  }

  return {
    getPaths() {
      return {
        repoRoot,
        contentDir,
        uploadsDir,
        contentFiles: { ...CONTENT_FILES }
      };
    },

    async readJson(key) {
      const target = resolveContentPath(key);
      const raw = await readFile(target, 'utf8');
      return JSON.parse(raw.replace(/^\uFEFF/, ''));
    },

    async readAllContent() {
      const [settings, columns, gallery, tarot, instagram] = await Promise.all([
        this.readJson('settings'),
        this.readJson('columns'),
        this.readJson('gallery'),
        this.readJson('tarot'),
        this.readJson('instagram')
      ]);
      return { settings, columns, gallery, tarot, instagram };
    },

    async writeJson(key, data) {
      const target = resolveContentPath(key);
      const payload = `${JSON.stringify(data, null, 2)}\n`;
      await writeAtomicFile(target, Buffer.from(payload, 'utf8'));
      return {
        key,
        relativePath: CONTENT_FILES[key],
        absolutePath: target
      };
    },

    async saveUploadedImage({ filename, buffer }) {
      const safeName = validateUploadFilename(filename);
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('画像データが空です');
      }
      if (buffer.length > MAX_UPLOAD_BYTES) {
        throw new Error(`画像サイズが上限 (${MAX_UPLOAD_BYTES} bytes) を超えています: ${buffer.length} bytes`);
      }

      await mkdir(uploadsDir, { recursive: true });
      const target = resolve(uploadsDir, safeName);
      if (!target.startsWith(uploadsDir + sep)) {
        throw new Error('保存先パスが images/uploads の外を指しています');
      }

      await writeAtomicFile(target, buffer);
      return {
        filename: safeName,
        relativePath: `images/uploads/${safeName}`,
        publicPath: `/omochi-tune/images/uploads/${safeName}`,
        bytes: buffer.length,
        absolutePath: target
      };
    }
  };
}
