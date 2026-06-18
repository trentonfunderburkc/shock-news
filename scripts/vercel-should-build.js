/**
 * Vercel Ignored Build Step
 * exit 0 = пропустить сбор (статьи/картинки не трогаем)
 * exit 1 = собрать сайт
 *
 * Пропускаем build если:
 * - redeploy того же коммита (только env, напр. ANDROID_REDIRECT_*)
 * - изменились только middleware / vercel.json / docs
 */

import { execSync } from 'child_process';

const prev = process.env.VERCEL_GIT_PREVIOUS_SHA;
const curr = process.env.VERCEL_GIT_COMMIT_SHA;

if (!curr) {
  process.exit(1);
}

if (!prev) {
  console.log('[vercel-should-build] первый деплой — запускаем astro build');
  process.exit(1);
}

if (prev === curr) {
  console.log('[vercel-should-build] redeploy того же коммита — сбор пропущен');
  process.exit(0);
}

let files = [];
try {
  files = execSync(`git diff --name-only ${prev} ${curr}`, { encoding: 'utf-8' })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  process.exit(1);
}

if (files.length === 0) {
  console.log('[vercel-should-build] нет изменений в git — сбор пропущен');
  process.exit(0);
}

const BUILD_TRIGGERS = [
  'src/',
  'public/images/',
  'public/avatars/',
  'scripts/fetch-articles.js',
  'scripts/seed-comments.js',
  'scripts/generate-authors.js',
  'scripts/image-prompt.js',
  'scripts/gemini.js',
  'rss-sources.json',
  'package.json',
  'package-lock.json',
  'astro.config.mjs',
  'src/content.config.ts',
  'src/data/',
  'src/styles/',
];

const needsBuild = files.some((file) =>
  BUILD_TRIGGERS.some((prefix) => file === prefix || file.startsWith(prefix))
);

if (needsBuild) {
  console.log('[vercel-should-build] изменился контент — запускаем astro build');
  process.exit(1);
}

console.log('[vercel-should-build] только конфиг/редirect — сбор пропущен:', files.join(', '));
process.exit(0);
