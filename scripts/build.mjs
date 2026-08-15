import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const siteUrl = 'https://kanta13jp1.github.io/omochi-tune/';

if (dirname(output) !== root || output === root) {
  throw new Error('Refusing to replace an unexpected build directory.');
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ['index.html']) {
  await cp(join(root, file), join(output, file));
}

for (const directory of ['admin', 'content', 'images', 'vendor']) {
  await cp(join(root, directory), join(output, directory), { recursive: true });
}

const columns = JSON.parse(await readFile(join(root, 'content', 'columns.json'), 'utf8'));

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textOnly(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pubDate(value) {
  const normalized = String(value ?? '').replace(/\./g, '-');
  const date = new Date(`${normalized}T00:00:00+09:00`);
  return Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
}

const items = [...columns]
  .sort((a, b) => String(b.date).localeCompare(String(a.date)))
  .map((column) => {
    const link = `${siteUrl}#column/${encodeURIComponent(column.id)}`;
    return `    <item>
      <title>${xml(column.title)}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="true">${xml(link)}</guid>
      <pubDate>${xml(pubDate(column.date))}</pubDate>
      <category>${xml(column.tag)}</category>
      <description>${xml(column.summary || textOnly(column.content))}</description>
    </item>`;
  })
  .join('\n');

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OMOCHI TUNE おもちコラム</title>
    <link>${siteUrl}</link>
    <description>おもちちゃんの日常、タロット、天井裏 “M” のおはなし。</description>
    <language>ja</language>
${items}
  </channel>
</rss>
`;

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;

const robots = `User-agent: *
Allow: /
Sitemap: ${siteUrl}sitemap.xml
`;

await writeFile(join(output, 'feed.xml'), feed, 'utf8');
await writeFile(join(output, 'sitemap.xml'), sitemap, 'utf8');
await writeFile(join(output, 'robots.txt'), robots, 'utf8');

console.log(`Built ${columns.length} columns into ${output}`);
