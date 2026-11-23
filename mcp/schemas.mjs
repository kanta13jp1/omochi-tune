import { extname } from 'node:path';
import { z } from 'zod';
import { getTokyoParts } from './schedule.mjs';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB

export const ALLOWED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

export const ALLOWED_COLUMN_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h3',
  'h4'
];

export const ALLOWED_COLUMN_ATTRS = new Set(['href', 'title', 'target', 'rel']);

export const AVATAR_OPTIONS = {
  wings: ['sky', 'pink', 'gold', 'none', 'ice', 'ice-summer'],
  face: ['smile', 'wink', 'relax', 'shock'],
  item: ['none', 'star', 'heart', 'candle'],
  special: ['ice', 'ice-summer']
};

export function todayJstDot(now = new Date()) {
  const { year, month, day } = getTokyoParts(now);
  return `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`;
}

export function validateDateDot(value, fieldName = 'date') {
  const str = String(value ?? '').trim();
  const match = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(str);
  if (!match) {
    throw new Error(`${fieldName} は YYYY.MM.DD 形式（例: 2026.11.23）で指定してください`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} に存在しない日付が指定されました: ${str}`);
  }
  return str;
}

export function validateSafeUrl(
  value,
  { allowEmpty = false, allowRelativeImage = false, allowHash = false, fieldName = 'URL' } = {}
) {
  const candidate = String(value ?? '').trim();
  if (!candidate) {
    if (allowEmpty) return '';
    throw new Error(`${fieldName} は空にできません`);
  }

  if (/[\x00-\x1f\x7f\s]/.test(candidate)) {
    throw new Error(`${fieldName} に空白または制御文字は含められません`);
  }

  const lower = candidate.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:')) {
    throw new Error(`${fieldName} に危険なスキーム（javascript:/vbscript:/data:）は使用できません`);
  }

  if (allowHash && candidate.startsWith('#')) {
    return candidate;
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate);
  if (!hasScheme) {
    if (!allowRelativeImage) {
      throw new Error(`${fieldName} は http:// または https:// で始まる必要があります`);
    }
    if (candidate.startsWith('//') || candidate.includes('\\') || /(^|\/)\.\.(\/|$)/.test(candidate)) {
      throw new Error(`${fieldName} に不正な相対パスが含まれています: ${candidate}`);
    }
    return candidate;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${fieldName} の URL 形式が不正です: ${candidate}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${fieldName} は http: または https: のみ許可されています`);
  }
  return candidate;
}

export function validateAvatarString(value, { requirePrefix = false, fieldName = 'avatar' } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    throw new Error(`${fieldName} は空にできません`);
  }
  let spec = raw;
  if (requirePrefix) {
    if (!raw.startsWith('avatar:')) {
      throw new Error(`${fieldName} は avatar: で始まる必要があります`);
    }
    spec = raw.slice('avatar:'.length).trim();
  }

  if (AVATAR_OPTIONS.special.includes(spec)) {
    return requirePrefix ? `avatar:${spec}` : spec;
  }

  const parts = spec.split('|');
  if (parts.length !== 3) {
    throw new Error(
      `${fieldName} の形式が不正です。"wings|face|item"（例: sky|smile|none）または "ice" を指定してください`
    );
  }

  const [wings, face, item] = parts;
  if (!AVATAR_OPTIONS.wings.includes(wings)) {
    throw new Error(`${fieldName} の wings "${wings}" は不正です（許可: ${AVATAR_OPTIONS.wings.join(', ')}）`);
  }
  if (!AVATAR_OPTIONS.face.includes(face)) {
    throw new Error(`${fieldName} の face "${face}" は不正です（許可: ${AVATAR_OPTIONS.face.join(', ')}）`);
  }
  if (!AVATAR_OPTIONS.item.includes(item)) {
    throw new Error(`${fieldName} の item "${item}" は不正です（許可: ${AVATAR_OPTIONS.item.join(', ')}）`);
  }

  return requirePrefix ? `avatar:${spec}` : spec;
}

export function validateGalleryImage(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    throw new Error('gallery.image は空にできません（avatar:... または画像パス/URL を指定してください）');
  }
  if (raw.startsWith('avatar:')) {
    return validateAvatarString(raw, { requirePrefix: true, fieldName: 'gallery.image' });
  }
  return validateSafeUrl(raw, {
    allowEmpty: false,
    allowRelativeImage: true,
    fieldName: 'gallery.image'
  });
}

function escapeHtmlText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseTagAttributes(attrText) {
  const trimmed = attrText.trim();
  if (!trimmed || trimmed === '/') return;
  // Strip trailing self-closing slash only when separated by whitespace (e.g., `<br />`)
  const cleaned = /\s\/$/.test(trimmed) ? trimmed.slice(0, -1).trim() : trimmed;
  if (!cleaned) return;

  const attrPattern = /([a-zA-Z0-9_-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let lastIndex = 0;
  let match;
  while ((match = attrPattern.exec(cleaned)) !== null) {
    const gap = cleaned.slice(lastIndex, match.index);
    if (gap.trim() !== '') {
      throw new Error(`コラム本文のタグ属性構文が不正です: ${cleaned}`);
    }
    lastIndex = attrPattern.lastIndex;

    const attrName = match[1].toLowerCase();
    const attrVal = match[2] ?? match[3] ?? match[4] ?? '';
    if (attrName.startsWith('on')) {
      throw new Error(`コラム本文にイベントハンドラ属性 (${attrName}) は使用できません`);
    }
    if (!ALLOWED_COLUMN_ATTRS.has(attrName)) {
      throw new Error(
        `コラム本文で許可されていない属性です: ${attrName}（許可属性: ${[...ALLOWED_COLUMN_ATTRS].join(', ')}）`
      );
    }
    if (attrName === 'href') {
      validateSafeUrl(attrVal, { allowEmpty: false, allowHash: true, fieldName: 'a[href]' });
    }
  }
  if (cleaned.slice(lastIndex).trim() !== '') {
    throw new Error(`コラム本文のタグ属性構文が不正です: ${cleaned}`);
  }
}

export function validateColumnHtml(input) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error('コラム本文 (content) は空にできません');
  }

  const lower = raw.toLowerCase();
  if (
    /<\s*(script|iframe|object|embed|style|svg|form|input|textarea|button|link|meta)\b/i.test(raw) ||
    /\bon[a-z]+\s*=/i.test(raw) ||
    lower.includes('javascript:') ||
    lower.includes('vbscript:') ||
    lower.includes('data:text/html')
  ) {
    throw new Error('コラム本文に危険な HTML / スクリプト記述が含まれています');
  }

  const looksLikeHtml = /<\/?[a-zA-Z]/.test(raw) || /<!--|<!|<\?/.test(raw);
  if (!looksLikeHtml) {
    const paragraphs = raw
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${escapeHtmlText(p).replace(/\n/g, '<br>')}</p>`);
    if (paragraphs.length === 0) {
      throw new Error('コラム本文 (content) は空にできません');
    }
    return paragraphs.join('');
  }

  if (/<!--|<!|\<\?/.test(raw)) {
    throw new Error('コラム本文に HTML コメントや宣言は使用できません');
  }

  const allowedSet = new Set(ALLOWED_COLUMN_TAGS);
  const tagRegex = /<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g;
  let lastIndex = 0;
  let match;
  let tagCount = 0;

  while ((match = tagRegex.exec(raw)) !== null) {
    const textChunk = raw.slice(lastIndex, match.index);
    if (textChunk.includes('<') || textChunk.includes('>')) {
      throw new Error('コラム本文に閉じられていない "<" または ">" が含まれています');
    }
    lastIndex = tagRegex.lastIndex;
    tagCount += 1;

    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const attrPart = match[3] || '';

    if (!allowedSet.has(tagName)) {
      throw new Error(
        `コラム本文で許可されていないタグ <${tagName}> が含まれています（許可タグ: ${ALLOWED_COLUMN_TAGS.join(', ')}）`
      );
    }
    if (isClosing && attrPart.trim() !== '') {
      throw new Error(`閉じタグ </${tagName}> に属性は指定できません`);
    }
    if (!isClosing) {
      parseTagAttributes(attrPart);
    }
  }

  const tail = raw.slice(lastIndex);
  if (tail.includes('<') || tail.includes('>')) {
    throw new Error('コラム本文に閉じられていない "<" または ">" が含まれています');
  }
  if (tagCount === 0) {
    throw new Error('コラム本文の HTML タグ構文を解析できませんでした');
  }

  return raw;
}

export function validateUploadFilename(filename) {
  const raw = String(filename ?? '').trim();
  if (!raw) {
    throw new Error('ファイル名 (filename) は空にできません');
  }
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..') || /[\x00-\x1f\x7f]/.test(raw)) {
    throw new Error(`ファイル名にパス区切りや不正文字は含められません: ${raw}`);
  }
  if (raw.length > 120) {
    throw new Error('ファイル名は 120 文字以内で指定してください');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) {
    throw new Error('ファイル名は半角英数字・ドット・アンダースコア・ハイフンのみ使用できます');
  }
  const ext = extname(raw).toLowerCase();
  if (ext === '.svg') {
    throw new Error('セキュリティ保護のため SVG ファイルのアップロードは禁止されています（PNG/JPG/WEBP/GIF を使用してください）');
  }
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
    throw new Error(
      `対応していない画像拡張子です: ${ext || '(なし)'}（許可: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}）`
    );
  }
  return raw;
}

export const settingsSchema = z
  .object({
    showTarot: z.boolean(),
    showGallery: z.boolean(),
    showColumn: z.boolean(),
    showSchedule: z.boolean(),
    reservationUrl: z.string().trim().min(1),
    reservationLabel: z.string().trim().min(1),
    walkInText: z.string().trim().min(1),
    instagramUrl: z.string().trim().min(1),
    instagramHandle: z.string().trim().min(1),
    accessVideoUrl: z.string().trim()
  })
  .strict();

export function validateSettings(data) {
  const parsed = settingsSchema.parse(data);
  return {
    ...parsed,
    reservationUrl: validateSafeUrl(parsed.reservationUrl, { fieldName: 'reservationUrl' }),
    instagramUrl: validateSafeUrl(parsed.instagramUrl, { fieldName: 'instagramUrl' }),
    accessVideoUrl: validateSafeUrl(parsed.accessVideoUrl, { allowEmpty: true, fieldName: 'accessVideoUrl' })
  };
}

export const columnItemSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().trim().min(1),
    date: z.string().trim().min(1),
    tag: z.string().trim().min(1),
    readTime: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    content: z.string().trim().min(1),
    thumbnail: z.string().trim()
  })
  .strict();

export function validateColumnItem(item) {
  const parsed = columnItemSchema.parse(item);
  return {
    ...parsed,
    date: validateDateDot(parsed.date, 'column.date'),
    content: validateColumnHtml(parsed.content),
    thumbnail: validateSafeUrl(parsed.thumbnail, {
      allowEmpty: true,
      allowRelativeImage: true,
      fieldName: 'column.thumbnail'
    })
  };
}

export const galleryItemSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().trim().min(1),
    desc: z.string().trim().min(1),
    image: z.string().trim().min(1),
    date: z.string().trim().min(1),
    type: z.string().trim().min(1),
    features: z.string().trim().min(1)
  })
  .strict();

export function validateGalleryItem(item) {
  const parsed = galleryItemSchema.parse(item);
  return {
    ...parsed,
    image: validateGalleryImage(parsed.image),
    date: validateDateDot(parsed.date, 'gallery.date')
  };
}

export const tarotCardSchema = z
  .object({
    nameEn: z.string().trim().min(1),
    nameJp: z.string().trim().min(1),
    illust: z.string().trim().min(1),
    desc: z.string().trim().min(1),
    loveAdvice: z.string().trim()
  })
  .strict();

export function validateTarotCard(item) {
  return tarotCardSchema.parse(item);
}

export const instagramItemSchema = z
  .object({
    label: z.string().trim().min(1),
    alt: z.string().trim().min(1),
    url: z.string().trim().min(1),
    image: z.string().trim(),
    avatar: z.string().trim(),
    theme: z.enum(['', 'pink', 'night'])
  })
  .strict();

export function validateInstagramItem(item) {
  const parsed = instagramItemSchema.parse(item);
  return {
    ...parsed,
    url: validateSafeUrl(parsed.url, { fieldName: 'instagram.url' }),
    image: validateSafeUrl(parsed.image, {
      allowEmpty: true,
      allowRelativeImage: true,
      fieldName: 'instagram.image'
    }),
    avatar: parsed.avatar
      ? validateAvatarString(parsed.avatar, { requirePrefix: false, fieldName: 'instagram.avatar' })
      : ''
  };
}

export function validateAllContent({ settings, columns, gallery, tarot, instagram }) {
  const normalizedSettings = validateSettings(settings);

  if (!Array.isArray(columns)) throw new Error('content/columns.json は配列である必要があります');
  const colIds = new Set();
  const normalizedColumns = columns.map((col, idx) => {
    const valid = validateColumnItem(col);
    if (colIds.has(valid.id)) {
      throw new Error(`columns[${idx}] の ID (${valid.id}) が重複しています`);
    }
    colIds.add(valid.id);
    return valid;
  });

  if (!Array.isArray(gallery)) throw new Error('content/gallery.json は配列である必要があります');
  const galIds = new Set();
  const normalizedGallery = gallery.map((item, idx) => {
    const valid = validateGalleryItem(item);
    if (galIds.has(valid.id)) {
      throw new Error(`gallery[${idx}] の ID (${valid.id}) が重複しています`);
    }
    galIds.add(valid.id);
    return valid;
  });

  if (!Array.isArray(tarot)) throw new Error('content/tarot.json は配列である必要があります');
  if (tarot.length < 3) {
    throw new Error('タロット占い（3枚引きUI）には最低 3 枚のカードが必要です');
  }
  const tarotKeys = new Set();
  const normalizedTarot = tarot.map((card, idx) => {
    const valid = validateTarotCard(card);
    const key = valid.nameEn.toLowerCase();
    if (tarotKeys.has(key)) {
      throw new Error(`tarot[${idx}] の nameEn (${valid.nameEn}) が重複しています`);
    }
    tarotKeys.add(key);
    return valid;
  });

  if (!Array.isArray(instagram)) throw new Error('content/instagram.json は配列である必要があります');
  const normalizedInstagram = instagram.map((item) => validateInstagramItem(item));

  return {
    settings: normalizedSettings,
    columns: normalizedColumns,
    gallery: normalizedGallery,
    tarot: normalizedTarot,
    instagram: normalizedInstagram
  };
}
