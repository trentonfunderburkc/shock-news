import { getCollection } from 'astro:content';
import { site } from '../lib/site.js';

export async function GET() {
  const base = import.meta.env.BASE_URL;
  const siteUrl = (import.meta.env.SITE || site.siteUrl).replace(/\/$/, '');
  const stories = (await getCollection('stories')).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime()
  );

  const staticPages = [
    '',
    'about/',
    'contacts/',
    'editorial/',
    'privacy/',
    'terms/',
    'cookies/',
    'authors/',
    ...site.categories.map((c) => `category/${c.slug}/`),
  ];

  const urls = [
    ...staticPages.map((p) => `${siteUrl}${base}${p}`),
    ...stories.map((s) => `${siteUrl}${base}stories/${s.id}/`),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
