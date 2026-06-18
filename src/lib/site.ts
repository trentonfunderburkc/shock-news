import siteData from '../data/site.json';

export const site = siteData;

export function categorySlug(name: string): string {
  const found = site.categories.find((c) => c.name === name);
  return found?.slug ?? name.toLowerCase().replace(/\s+/g, '-');
}

export function categoryName(slug: string): string | undefined {
  return site.categories.find((c) => c.slug === slug)?.name;
}

export function categoryUrl(slug: string, base: string): string {
  return `${base}category/${slug}/`;
}

export function formatDateRu(date: Date): string {
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function formatDateShort(date: Date): string {
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function absoluteUrl(path: string, siteUrl: string, base: string): string {
  const clean = path.startsWith('http') ? path : `${siteUrl}${base}${path.replace(/^\//, '')}`;
  return clean.replace(/([^:]\/)\/+/g, '$1');
}
