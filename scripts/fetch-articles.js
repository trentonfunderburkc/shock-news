import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Parser from 'rss-parser';
import axios from 'axios';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { buildImagePrompt, extractSceneFromTitle, photoRealismWrapper } from './image-prompt.js';
import { atomicWriteFile, sanitizeForYaml, sleep, withRetry } from './lib/retry.js';
import { geminiGenerateText, geminiGenerateImage, isGeminiConfigured } from './gemini.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const rssSourcesPath = path.join(root, 'rss-sources.json');
const storiesDir = path.join(root, 'src', 'content', 'stories');
const imagesDir = path.join(root, 'public', 'images', 'stories');
const authorsPath = path.join(root, 'src', 'data', 'authors.json');

const TARGET_COUNT = parseInt(process.env.TARGET_COUNT || '50', 10);
const MAX_NEW = parseInt(process.env.MAX_NEW || '0', 10);
const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS || '7', 10);
const ALLOW_FALLBACK = process.env.ALLOW_FALLBACK === 'true';
const RESET = process.argv.includes('--reset');
const CONFIRM_RESET =
  process.argv.includes('--confirm-reset') || process.env.CONFIRM_RESET === 'true';
const REWRITE_MIN_CHARS = parseInt(process.env.REWRITE_MIN_CHARS || '1000', 10);
const REWRITE_MAX_CHARS = parseInt(process.env.REWRITE_MAX_CHARS || '2000', 10);

const REWRITE_SYSTEM_PROMPT =
  'Ты редактор новостного портала о происшествиях, криминале и чрезвычайных ситуациях. ' +
  `Напиши полноценную новость объёмом ${REWRITE_MIN_CHARS}–${REWRITE_MAX_CHARS} символов (4–6 абзацев). ` +
  'Сохрани все цифры, даты, имена и факты из оригинала. Не выдумывай то, чего нет в исходнике. ' +
  'Стиль: оперативный, понятный, без сенсационных домыслов. Язык русский. Без markdown и заголовков.';
const API_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || '60000', 10);
const API_DELAY_MS = parseInt(process.env.API_DELAY_MS || '500', 10);
const RSS_RETRY_ATTEMPTS = parseInt(process.env.RSS_RETRY_ATTEMPTS || '3', 10);
const imageProviderSetting = (process.env.IMAGE_PROVIDER || (isGeminiConfigured() ? 'gemini' : 'openai')).toLowerCase();
const SKIP_IMAGES =
  process.env.SKIP_IMAGES === 'true' ||
  ['none', 'skip', 'placeholder', 'off'].includes(imageProviderSetting);
const FORCE_IMAGES = process.env.FORCE_IMAGES === 'true';
const parser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': 'ShockNewsBot/1.0 (+https://github.com/shock-news)' },
});

const TOPIC_KEYWORDS = [
  'убий', 'убил', 'убита', 'погиб', 'труп', 'насил', 'избил', 'арест', 'задерж', 'поджог',
  'драк', 'нож', 'стрель', 'покуш', 'мошен', 'ограб', 'преступ', 'следств', 'пожар',
  'дтп', 'авар', 'крушен', 'изнасил', 'жертв', 'ранен', 'тело', 'скончал', 'пропал',
  'пропав', 'найден', 'утонул', 'взрыв', 'чп', 'трагед', 'напад', 'избиен', 'сизо',
  'приговор', 'колони', 'полици', 'следком', 'разбой', 'грабеж', 'похитил', 'задушил',
  'избили', 'ограбил', 'суд ', 'осудил', 'задержан', 'задержали', 'арестован',
  'происшеств', 'криминал', 'чрезвычай', 'пожар', 'обрушил', 'сгорел', 'утопл',
  'несчастн', 'травмир', 'пострадал', 'гибел', 'смерт', 'трагич', 'скандал',
];

const EXCLUDE_KEYWORDS = [
  'vpn', 'крипто', 'крипт', 'netflix', 'роскомнадзор', 'блокиров',
  'пенси', 'пенсион', 'налог', 'ндфл', 'пособи', 'льгот', 'маткапитал', 'сфр', 'пфр', 'фнс',
  'олимпиад', 'футбол', 'хокке', 'чемпионат', 'матч ', 'bitcoin', 'чм-20', 'чм ',
  'whatsapp', 'instagram', 'tiktok', 'youtube', 'warcraft', 'dota', 'steam',
  'всу', 'бпла', 'дрон', 'беспилотник', 'мобилиз', 'фронт', 'военн', 'спецоперац',
  'обстрел', 'нато', 'санкци', 'зеленск', 'трамп', 'путин', 'кремл', 'депутат', 'парламент',
  'украин', 'донбасс', 'новоросс', 'одесс', 'харьков', 'киев', 'миноборон', 'генштаб',
  'пленн', 'боевых', 'боевой', 'сво ', 'свo', 'ракетн', 'воздушн', 'тревог', 'пво',
  'аэропорт', 'росавиаци', 'внуково', 'домодедово', 'шереметьево', 'одкб', 'лукашенко',
  'миршаймер', 'госизмен', 'тцк', 'игил', 'терроризм', 'финансирован.*террор',
  'бирж', 'курс валют', 'нефть', 'бензин', 'эколог', 'волонт', 'благотвор',
  'кино', 'актрис', 'актёр', 'актер', 'пугачев', 'звезд', 'шоу-биз', 'блогер',
  'рецепт', 'диет', 'кошк', 'собак', 'растени', 'баклажан', 'чеснок', 'шашлык',
];

const CONTENT_ONLY_EXCLUDE = [];

const RELAXED_TITLE_PATTERNS = [
  /убий/i, /погиб/i, /погибл/i, /смерт/i, /труп/i, /тело/i,
  /дтп/i, /авар/i, /крушен/i, /столкновен/i, /наезд/i,
  /пожар/i, /взрыв/i, /чп/i, /происшеств/i, /криминал/i,
  /арест/i, /задерж/i, /суд /i, /приговор/i, /сизо/i,
  /мошен/i, /ограб/i, /похитил/i, /насил/i, /избил/i,
  /пропал/i, /пропав/i, /найден/i, /утонул/i, /жертв/i,
  /ранен/i, /пострадал/i, /трагед/i, /скандал/i,
];

const STRONG_TOPIC_KEYWORDS = [
  'убий', 'погиб', 'труп', 'дтп', 'авар', 'пожар', 'взрыв', 'арест', 'задерж',
  'мошен', 'ограб', 'преступ', 'следств', 'пропал', 'утонул', 'жертв', 'ранен',
  'происшеств', 'криминал', 'чп', 'приговор', 'сизо', 'насил', 'избил',
];

function hasTopicKeyword(text, keyword) {
  const k = keyword.toLowerCase();
  const t = text.toLowerCase();
  const shortExact = ['едв', 'мфц', 'сфр', 'пфр', 'фнс', 'жкх', 'мрот', 'сфр'];
  if (shortExact.includes(k)) {
    return new RegExp(`(?:^|[^а-яёa-z0-9])${k}(?:[^а-яёa-z0-9]|$)`, 'i').test(t);
  }
  return t.includes(k);
}

function textHasTopicKeyword(text, keywords) {
  return keywords.some((kw) => hasTopicKeyword(text, kw));
}

function titleMatchesSocialTopic(title) {
  const titleLower = title.toLowerCase();
  return (
    textHasTopicKeyword(titleLower, STRONG_TOPIC_KEYWORDS) ||
    RELAXED_TITLE_PATTERNS.some((re) => re.test(title))
  );
}

function isExcluded(combined, titleLower) {
  if (EXCLUDE_KEYWORDS.some((kw) => combined.includes(kw))) return true;
  if (/(?:^|[^а-яё])всу(?:[^а-яё]|$)/i.test(combined)) return true;
  if (/бпла|беспилотник|\bпво\b/i.test(combined)) return true;
  if (/дрон/i.test(combined) && /сбит|сбил|атак|удар|всу|украин/i.test(combined)) return true;
  if (/политик|депутат|парламент|нато|санкци/i.test(combined)) return true;
  return false;
}

const CATEGORY_RULES = [
  [/дтп|авар|столкновен|наезд|маршрутк|фургон|автобус.*столкн/i, 'ДТП'],
  [/пожар|взрыв|чп|чрезвычай|обрушил|сгорел|задымлен/i, 'ЧП'],
  [/убий|преступ|арест|задерж|мошен|ограб|суд |приговор|сизо|следств|криминал|разбой/i, 'Криминал'],
  [/происшеств|пропал|утонул|найден|тело|жертв|трагед|пострадал/i, 'Происшествия'],
];

function isTopicRelevant(title, text, source, { relaxed = false, broad = false } = {}) {
  if (!source.filter) return true;
  const titleLower = title.toLowerCase();
  const combined = `${title} ${text}`.toLowerCase();
  if (isExcluded(combined, titleLower)) return false;

  if (broad) {
    return (
      titleMatchesSocialTopic(titleLower) &&
      textHasTopicKeyword(combined, STRONG_TOPIC_KEYWORDS)
    );
  }

  if (relaxed) {
    return RELAXED_TITLE_PATTERNS.some((re) => re.test(title));
  }

  const inTitle = textHasTopicKeyword(titleLower, STRONG_TOPIC_KEYWORDS);
  const inCombined = textHasTopicKeyword(combined, STRONG_TOPIC_KEYWORDS);

  if (source.strictTitle) return inTitle;
  if (source.strict) return inCombined;
  return inCombined || textHasTopicKeyword(combined, TOPIC_KEYWORDS);
}

function detectCategory(title, text, defaultCategory) {
  const combined = `${title} ${text}`;
  for (const [pattern, cat] of CATEGORY_RULES) {
    if (pattern.test(combined)) return cat;
  }
  return defaultCategory || 'Происшествия';
}

function parseItemDate(item) {
  const raw = item.isoDate || item.pubDate;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isRecentNews(item) {
  const date = parseItemDate(item);
  if (!date) return false;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);
  return date >= cutoff;
}

function formatAgeHint(date) {
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function clearContent() {
  if (fs.existsSync(storiesDir)) {
    for (const file of fs.readdirSync(storiesDir).filter((f) => f.endsWith('.md'))) {
      fs.unlinkSync(path.join(storiesDir, file));
    }
  }
  if (fs.existsSync(imagesDir)) {
    for (const file of fs.readdirSync(imagesDir)) {
      fs.unlinkSync(path.join(imagesDir, file));
    }
  }
  console.log('🗑  Старый контент удалён');
}

const CATEGORY_MAP = {
  'Происшествия': 'Происшествия',
  'Криминал': 'Криминал',
  'ДТП': 'ДТП',
  'ЧП': 'ЧП',
};

const FALLBACK_TOPICS = [
  { title: 'В регионе зафиксировано ДТП с пострадавшими', category: 'ДТП', source_name: 'МК', source_url: 'https://www.mk.ru/incident/' },
  { title: 'Следствие возбудило уголовное дело после нападения на прохожего', category: 'Криминал', source_name: 'Lenta.ru', source_url: 'https://lenta.ru/rss/news/forces' },
  { title: 'Пожар в жилом доме локализован, пострадавших нет', category: 'ЧП', source_name: 'АиФ', source_url: 'https://aif.ru/rss/incidents.php' },
  { title: 'Пропавшего человека нашли в лесном массиве', category: 'Происшествия', source_name: 'Mail.ru', source_url: 'https://news.mail.ru/rss/incident/' },
];

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => {
      const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
      return map[c] || c;
    })
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || `story-${Date.now()}`;
}

function decodeHtmlEntities(text) {
  return (text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function normalizeTitle(raw) {
  const title = decodeHtmlEntities(raw || '').replace(/\s+/g, ' ').trim();
  return title || 'Без заголовка';
}

function stripHtml(html) {
  return decodeHtmlEntities(
    (html || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function getExistingSlugs() {
  if (!fs.existsSync(storiesDir)) return new Set();
  return new Set(
    fs.readdirSync(storiesDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace('.md', ''))
  );
}

function normalizeUrl(url) {
  return (url || '').replace(/\/$/, '').trim();
}

function getExistingSourceUrls() {
  if (!fs.existsSync(storiesDir)) return new Set();
  const urls = new Set();
  for (const file of fs.readdirSync(storiesDir).filter((f) => f.endsWith('.md'))) {
    const content = fs.readFileSync(path.join(storiesDir, file), 'utf-8');
    const match = content.match(/source_url:\s*(?:>\-?\s*\n\s*)?["']?(https?:\/\/[^\s"'>\n]+)/);
    if (match) urls.add(normalizeUrl(match[1]));
  }
  return urls;
}

function loadAuthors() {
  if (fs.existsSync(authorsPath)) {
    return JSON.parse(fs.readFileSync(authorsPath, 'utf-8'));
  }
  return Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    name: `Автор ${i + 1}`,
  }));
}

function loadSources() {
  if (!fs.existsSync(rssSourcesPath)) {
    throw new Error(`Файл источников не найден: ${rssSourcesPath}`);
  }
  const sources = JSON.parse(fs.readFileSync(rssSourcesPath, 'utf-8'));
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('rss-sources.json пуст или не является массивом');
  }
  return sources;
}

function validateStartup() {
  const sources = loadSources();
  loadAuthors();

  const hasDeepSeek = process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY !== 'sk-...';
  const hasOpenAI = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-...';
  const hasGemini = isGeminiConfigured();
  if (!hasDeepSeek && !hasOpenAI && !hasGemini) {
    console.warn('⚠  API-ключи AI не заданы — рерайт будет локальным (fallback)');
  }
  if (!SKIP_IMAGES && !hasGemini && !hasOpenAI && !process.env.UNSPLASH_ACCESS_KEY) {
    console.warn('⚠  Ключи для картинок не заданы — будут SVG-placeholder');
  }

  return sources;
}

async function fetchFeedWithRetry(url, sourceName) {
  return withRetry(() => parser.parseURL(url), {
    attempts: RSS_RETRY_ATTEMPTS,
    delays: [1500, 4000, 10000],
    label: `RSS ${sourceName}`,
  });
}

function buildAiProviders() {
  const preferred = (process.env.AI_PROVIDER || 'deepseek').toLowerCase();
  const simulateDeepSeekFail = process.env.SIMULATE_DEEPSEEK_FAIL === 'true';
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const providers = [];

  const addOpenAI = () => {
    if (openaiKey && openaiKey !== 'sk-...') {
      providers.push({ name: 'OpenAI', type: 'openai', apiKey: openaiKey, model: 'gpt-4o-mini' });
    }
  };
  const addDeepSeek = () => {
    if (deepseekKey && deepseekKey !== 'sk-...') {
      providers.push({
        name: 'DeepSeek',
        type: 'openai',
        apiKey: deepseekKey,
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-chat',
      });
    }
  };
  const addGemini = () => {
    if (isGeminiConfigured()) {
      providers.push({ name: 'Gemini', type: 'gemini' });
    }
  };

  if (preferred === 'openai') {
    addOpenAI();
    addDeepSeek();
  } else if (preferred === 'gemini') {
    addGemini();
    addOpenAI();
    addDeepSeek();
  } else {
    addDeepSeek();
    addOpenAI();
    addGemini();
  }

  if (simulateDeepSeekFail) {
    console.warn('⚠  SIMULATE_DEEPSEEK_FAIL: DeepSeek отключён для теста failover');
    return providers.filter((p) => p.name !== 'DeepSeek');
  }
  return providers;
}

function pickAuthor(authors) {
  return authors[Math.floor(Math.random() * authors.length)];
}

function fallbackRewrite(title, originalText) {
  const text = originalText || title;
  let result = text;
  if (result.length < REWRITE_MIN_CHARS) {
    result = `${title}. ${result} Подробности уточняются в официальных источниках.`;
  }
  if (result.length > REWRITE_MAX_CHARS) {
    result = result.slice(0, REWRITE_MAX_CHARS).replace(/\s+\S*$/, '') + '…';
  }
  return result;
}

async function aiRewrite(title, originalText) {
  const providers = buildAiProviders();
  if (providers.length === 0) {
    return fallbackRewrite(title, originalText);
  }

  for (const provider of providers) {
    try {
      if (provider.name === 'DeepSeek' && process.env.SIMULATE_DEEPSEEK_FAIL === 'true') {
        throw new Error('Simulated DeepSeek failure');
      }

      let text;
      const sourceSlice = originalText.slice(0, 4000);
      if (provider.type === 'gemini') {
        text = await geminiGenerateText({
          system: REWRITE_SYSTEM_PROMPT,
          user: `Заголовок: ${title}\n\nОригинал:\n${sourceSlice}`,
        });
      } else {
        const response = await withRetry(
          async () => {
            const client = new OpenAI({
              apiKey: provider.apiKey,
              baseURL: provider.baseURL,
              timeout: API_TIMEOUT_MS,
              maxRetries: 0,
            });
            return client.chat.completions.create({
              model: provider.model,
              messages: [
                { role: 'system', content: REWRITE_SYSTEM_PROMPT },
                { role: 'user', content: `Заголовок: ${title}\n\nОригинал:\n${sourceSlice}` },
              ],
              max_tokens: 1500,
            });
          },
          { attempts: 3, label: `AI ${provider.name}` }
        );
        text = response.choices[0]?.message?.content?.trim();
      }

      if (text && text.length >= Math.min(REWRITE_MIN_CHARS, 800)) {
        if (text.length > REWRITE_MAX_CHARS) {
          text = text.slice(0, REWRITE_MAX_CHARS).replace(/\s+\S*$/, '') + '…';
        }
        console.log(
          `  [${provider.name}] рерайт: ${originalText.length} → ${text.length} символов`
        );
        return text;
      }
    } catch (err) {
      console.warn(`  [${provider.name}] ошибка: ${err.message}`);
    }
  }

  return fallbackRewrite(title, originalText);
}

function writePlaceholderImage(slug) {
  fs.mkdirSync(imagesDir, { recursive: true });
  const svgDest = path.join(imagesDir, `${slug}.svg`);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect fill="#8a8a85" width="800" height="450"/><rect fill="#6b6b66" x="0" y="320" width="800" height="130"/></svg>';
  atomicWriteFile(svgDest, svg);
  return { path: `/images/stories/${slug}.svg`, credit: 'Placeholder' };
}

function reuseExistingImage(slug, { allowPlaceholder = false } = {}) {
  const real = ['.jpg', '.jpeg', '.webp'];
  const all = allowPlaceholder ? [...real, '.svg'] : real;
  for (const ext of all) {
    const file = path.join(imagesDir, `${slug}${ext}`);
    if (fs.existsSync(file)) {
      return {
        path: `/images/stories/${slug}${ext}`,
        credit: ext === '.svg' ? 'Placeholder' : 'Existing image',
      };
    }
  }
  return null;
}

async function fetchGeminiImage(title, category, slug, body = '') {
  if (!isGeminiConfigured()) return null;

  fs.mkdirSync(imagesDir, { recursive: true });
  const dest = path.join(imagesDir, `${slug}.jpg`);
  const publicPath = `/images/stories/${slug}.jpg`;

  const tryGenerate = async (prompt) => {
    await geminiGenerateImage(prompt, dest);
    return true;
  };

  try {
    const prompt = await buildImagePrompt(title, category, body);
    if (await tryGenerate(prompt)) {
      const sceneHint = extractSceneFromTitle(title) || 'photo';
      console.log(`  [Gemini Image] сохранено — ${sceneHint.slice(0, 50)}…`);
      return { path: publicPath, credit: 'Generated by AI (Gemini)' };
    }
  } catch (err) {
    console.warn(`  [Gemini Image] ${err.message}, retry…`);
    try {
      const fallbackPrompt = photoRealismWrapper(extractSceneFromTitle(`${title} ${body}`));
      if (await tryGenerate(fallbackPrompt)) {
        console.log(`  [Gemini Image] сохранено (retry)`);
        return { path: publicPath, credit: 'Generated by AI (Gemini)' };
      }
    } catch (retryErr) {
      console.warn(`  [Gemini Image] retry failed: ${retryErr.message}`);
    }
  }
  return null;
}

async function fetchDalleImage(title, category, slug, body = '') {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || openaiKey === 'sk-...') return null;

  fs.mkdirSync(imagesDir, { recursive: true });
  const dest = path.join(imagesDir, `${slug}.jpg`);
  const publicPath = `/images/stories/${slug}.jpg`;

  const tryGenerate = async (prompt) => {
    const response = await withRetry(
      async () => {
        const client = new OpenAI({ apiKey: openaiKey, timeout: API_TIMEOUT_MS, maxRetries: 0 });
        return client.images.generate({
          model: 'gpt-image-1',
          prompt,
          n: 1,
          size: '1536x1024',
        });
      },
      { attempts: 2, label: 'OpenAI Image' }
    );
    const item = response.data[0];
    if (item?.b64_json) {
      atomicWriteFile(dest, Buffer.from(item.b64_json, 'base64'));
      return true;
    }
    if (item?.url) {
      const imgRes = await withRetry(
        () => axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000 }),
        { attempts: 3, label: 'Image download' }
      );
      atomicWriteFile(dest, imgRes.data);
      return true;
    }
    return false;
  };

  try {
    const prompt = await buildImagePrompt(title, category, body);
    if (await tryGenerate(prompt)) {
      const sceneHint = extractSceneFromTitle(title) || 'photo';
      console.log(`  [OpenAI Image] сохранено — ${sceneHint.slice(0, 50)}…`);
      return { path: publicPath, credit: 'Generated by AI (OpenAI)' };
    }
  } catch (err) {
    console.warn(`  [OpenAI Image] ${err.message}, retry…`);
    try {
      const fallbackPrompt = photoRealismWrapper(extractSceneFromTitle(`${title} ${body}`));
      if (await tryGenerate(fallbackPrompt)) {
        console.log(`  [OpenAI Image] сохранено (retry)`);
        return { path: publicPath, credit: 'Generated by AI (OpenAI)' };
      }
    } catch (retryErr) {
      console.warn(`  [OpenAI Image] retry failed: ${retryErr.message}`);
    }
  }
  return null;
}

function imageKeywords(title, category) {
  const map = {
    'Происшествия': 'crime scene Russia documentary',
    'Криминал': 'police investigation Russia',
    'ДТП': 'car accident road Russia',
    'ЧП': 'emergency Russia firefighters',
  };
  return `${map[category] || 'social benefits'} ${title.split(' ').slice(0, 3).join(' ')}`;
}

async function fetchUnsplashImage(keywords, slug, title, category, body = '') {
  if (!FORCE_IMAGES) {
    const existing = reuseExistingImage(slug);
    if (existing) {
      console.log('  [Image] пропуск — уже есть файл на диске');
      return existing;
    }
  }

  if (SKIP_IMAGES) {
    const placeholder = reuseExistingImage(slug, { allowPlaceholder: true });
    if (placeholder) return placeholder;
    console.log('  [Image] пропуск — placeholder (SKIP_IMAGES)');
    return writePlaceholderImage(slug);
  }

  const imageProvider = imageProviderSetting;
  const hasGemini = isGeminiConfigured();
  const hasOpenAI = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-...';

  const tryGemini =
    hasGemini && (imageProvider === 'gemini' || imageProvider === 'auto' || imageProvider === 'openai');
  const tryOpenAI =
    hasOpenAI && (imageProvider === 'openai' || imageProvider === 'auto' || imageProvider === 'gemini');

  if (tryGemini) {
    const gemini = await fetchGeminiImage(title, category, slug, body);
    if (gemini) return gemini;
  }

  if (tryOpenAI) {
    const dalle = await fetchDalleImage(title, category, slug, body);
    if (dalle) return dalle;
  }

  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  fs.mkdirSync(imagesDir, { recursive: true });
  const dest = path.join(imagesDir, `${slug}.jpg`);
  const publicPath = `/images/stories/${slug}.jpg`;

  if ((imageProvider === 'unsplash' || imageProvider === 'auto') && accessKey && accessKey !== '...') {
    try {
      const res = await withRetry(
        () =>
          axios.get('https://api.unsplash.com/search/photos', {
            params: { query: keywords, per_page: 1, orientation: 'landscape' },
            headers: { Authorization: `Client-ID ${accessKey}` },
            timeout: 15000,
          }),
        { attempts: 3, label: 'Unsplash search' }
      );
      const photo = res.data.results?.[0];
      if (photo) {
        const imgRes = await withRetry(
          () => axios.get(photo.urls.regular, { responseType: 'arraybuffer', timeout: 15000 }),
          { attempts: 3, label: 'Unsplash download' }
        );
        atomicWriteFile(dest, imgRes.data);
        const credit = photo.user?.name
          ? `Photo by ${photo.user.name} on Unsplash`
          : 'Photo on Unsplash';
        return { path: publicPath, credit };
      }
    } catch (err) {
      console.warn(`  [Unsplash API] ${err.message}`);
    }
  }

  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect fill="#8a8a85" width="800" height="450"/><rect fill="#6b6b66" x="0" y="320" width="800" height="130"/></svg>`;
    const svgDest = path.join(imagesDir, `${slug}.svg`);
    atomicWriteFile(svgDest, svg);
    console.warn(`  [Image] placeholder — генерация не удалась для ${slug}`);
    return { path: `/images/stories/${slug}.svg`, credit: 'Placeholder' };
  } catch {
    return writePlaceholderImage(slug);
  }
}

function formatDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
  return d.toISOString().split('T')[0];
}

function extractHelpLink(content, link) {
  const text = stripHtml(content);
  const urlMatch = text.match(/https?:\/\/[^\s]+(?:dobro|pomosh|help|donate|fond)[^\s]*/i);
  if (urlMatch) return urlMatch[0].replace(/[.,)]+$/, '');
  if (/пomosh|dobro|donate|фонд|помочь/i.test(text)) return link;
  return null;
}

async function saveArticle({ title, body, date, category, source_url, source_name, original_author, help_link }, authors, existingSlugs) {
  const safeTitle = sanitizeForYaml(title);
  const safeBody = body;
  let slug = slugify(safeTitle);
  let counter = 1;
  while (existingSlugs.has(slug)) {
    slug = `${slugify(safeTitle)}-${counter++}`;
  }

  const author = pickAuthor(authors);
  const mappedCategory = detectCategory(safeTitle, safeBody, CATEGORY_MAP[category] || category);
  const keywords = imageKeywords(safeTitle, mappedCategory);
  const { path: imagePath, credit } = await fetchUnsplashImage(keywords, slug, safeTitle, mappedCategory, safeBody);

  const sourceBlock = `\n\n---\n\n*Материал подготовлен на основе публикации [${source_name}](${source_url}). Ознакомиться с полной версией можно по [ссылке](${source_url}).*`;

  const frontmatter = `---
title: "${safeTitle.replace(/"/g, '\\"')}"
author: "${sanitizeForYaml(author.name).replace(/"/g, '\\"')}"
authorId: ${author.id}
date: ${formatDate(date)}
category: "${sanitizeForYaml(mappedCategory).replace(/"/g, '\\"')}"
source_url: "${source_url}"
source_name: "${sanitizeForYaml(source_name).replace(/"/g, '\\"')}"
original_author: ${original_author ? `"${sanitizeForYaml(original_author).replace(/"/g, '\\"')}"` : 'null'}
image: "${imagePath}"
image_credit: "${sanitizeForYaml(credit).replace(/"/g, '\\"')}"
comments: []
help_link: ${help_link ? `"${help_link}"` : 'null'}
---

${safeBody}${sourceBlock}
`;

  fs.mkdirSync(storiesDir, { recursive: true });
  atomicWriteFile(path.join(storiesDir, `${slug}.md`), frontmatter);
  existingSlugs.add(slug);

  console.log(`✓ [${existingSlugs.size}] ${safeTitle.slice(0, 60)}… (${safeBody.length} симв.)`);
  return slug;
}

function generateFallbackBody(topic) {
  const bodies = {
    'Происшествия': `По предварительным данным, в регионе произошло происшествие, в результате которого пострадали люди. На месте работают экстренные службы. Причины случившегося устанавливаются. Подробности уточняются.`,
    'Криминал': `Правоохранительные органы возбудили уголовное дело по факту преступления. Следствие проводит проверку и устанавливает обстоятельства произошедшего. Подозреваемые задержаны, материалы переданы в суд.`,
    'ДТП': `На дороге произошло дорожно-транспортное происшествие. По предварительной информации, есть пострадавшие. На месте работают сотрудники ГИБДД и скорая помощь. Движение транспорта временно затруднено.`,
    'ЧП': `В регионе зафиксировано чрезвычайное происшествие. На месте работают экстренные службы. Пострадавшим оказывается помощь. Причины и масштаб происшествия уточняются.`,
  };
  return bodies[topic.category] || bodies['Происшествия'];
}

async function main() {
  if (process.env.VERCEL === '1') {
    console.error('fetch-articles.js не запускается на Vercel — только локально или в GitHub Actions');
    process.exit(1);
  }

  if (RESET && !CONFIRM_RESET) {
    console.error('⚠  --reset удалит весь контент. Добавьте --confirm-reset или CONFIRM_RESET=true');
    process.exit(1);
  }

  console.log(`Загрузка статей из RSS (не старше ${MAX_AGE_DAYS} дн.)...`);
  if (SKIP_IMAGES) {
    console.log('🖼  SKIP_IMAGES: Gemini/OpenAI не вызываются, только placeholder или уже сохранённые файлы\n');
  } else {
    console.log('');
  }
  if (RESET) clearContent();
  fs.mkdirSync(storiesDir, { recursive: true });

  const sources = validateStartup();
  const authors = loadAuthors();
  const existingSlugs = getExistingSlugs();
  const existingUrls = getExistingSourceUrls();
  let count = existingSlugs.size;
  const initialCount = count;
  const maxToAdd = MAX_NEW > 0 ? MAX_NEW : TARGET_COUNT - count;
  const failedFeeds = [];
  const feedSuccess = new Set();

  if (maxToAdd <= 0 || count >= TARGET_COUNT) {
    console.log(`Уже есть ${count} статей. Цель достигнута.`);
    return;
  }

  const stopAt = MAX_NEW > 0 ? count + maxToAdd : TARGET_COUNT;
  let skippedOld = 0;
  let skippedNoDate = 0;
  let itemErrors = 0;

  async function processFeedItems(relaxed = false, broad = false) {
    const passLabel = broad ? 'Broad' : relaxed ? 'Relaxed' : 'Strict';

    for (const source of sources) {
      if (count >= stopAt) break;

      try {
        if (!relaxed && !broad) {
          console.log(`Парсинг: ${source.name} (${source.url})`);
        }
        const feed = await fetchFeedWithRetry(source.url, source.name);
        feedSuccess.add(`${source.name}|${source.url}`);
        const items = [...(feed.items || [])].sort((a, b) => {
          const da = parseItemDate(a)?.getTime() ?? 0;
          const db = parseItemDate(b)?.getTime() ?? 0;
          return db - da;
        });

        for (const item of items) {
          if (count >= stopAt) break;
          if (!item.link || existingUrls.has(normalizeUrl(item.link))) continue;

          const itemDate = parseItemDate(item);
          if (!itemDate) {
            if (!relaxed && !broad) skippedNoDate++;
            continue;
          }
          if (!isRecentNews(item)) {
            if (!relaxed && !broad) skippedOld++;
            continue;
          }

          const originalText = stripHtml(item.content || item.contentSnippet || item.summary || '');
          if (originalText.length < 50 && !item.title) continue;

          const title = normalizeTitle(item.title);
          if (!isTopicRelevant(title, originalText, source, { relaxed, broad })) {
            continue;
          }

          try {
            const body = await aiRewrite(title, originalText || title);
            const originalLen = originalText.length || title.length;
            const pct = Math.round((body.length / originalLen) * 100);
            console.log(`  [${passLabel}] ${originalLen} → ${body.length} (${pct}%) · ${formatAgeHint(itemDate)}`);

            await saveArticle(
              {
                title,
                body,
                date: itemDate.toISOString(),
                category: detectCategory(title, originalText || body, source.category),
                source_url: item.link,
                source_name: source.name,
                original_author: item.creator || item.author || null,
                help_link: extractHelpLink(item.content || '', item.link),
              },
              authors,
              existingSlugs
            );

            existingUrls.add(normalizeUrl(item.link));
            count++;

            if (API_DELAY_MS > 0 && !SKIP_IMAGES) {
              await sleep(API_DELAY_MS);
            }
          } catch (err) {
            itemErrors++;
            console.warn(`  ✗ Ошибка статьи «${title.slice(0, 50)}»: ${err.message}`);
          }
        }
      } catch (err) {
        const key = `${source.name}|${source.url}`;
        if (!relaxed && !broad) {
          console.warn(`✗ RSS недоступен: ${source.name} — ${err.message}`);
        }
        if (!feedSuccess.has(key)) {
          const existing = failedFeeds.find((f) => f.url === source.url);
          if (existing) {
            existing.error = err.message;
          } else {
            failedFeeds.push({ name: source.name, url: source.url, error: err.message });
          }
        }
      }
    }
  }

  await processFeedItems(false);

  if (count < stopAt) {
    console.log(`\n↻ Добор до ${stopAt}: расширенный поиск по заголовкам…`);
    await processFeedItems(true);
  }

  if (count < stopAt) {
    console.log(`\n↻ Добор до ${stopAt}: расширенный поиск по заголовкам…`);
    await processFeedItems(false, true);
  }

  if (skippedOld > 0 || skippedNoDate > 0) {
    console.log(`\n⏭  Пропущено: ${skippedOld} старше ${MAX_AGE_DAYS} дн., ${skippedNoDate} без даты`);
  }

  if (ALLOW_FALLBACK) {
    let fallbackIndex = 0;
    while (count < stopAt) {
      const topic = FALLBACK_TOPICS[fallbackIndex % FALLBACK_TOPICS.length];
      fallbackIndex++;
      const uniqueUrl = `${topic.source_url}?generated=${fallbackIndex}`;
      if (existingUrls.has(uniqueUrl)) continue;

      try {
        const body = generateFallbackBody(topic);
        const fullBody = await aiRewrite(topic.title, body);

        await saveArticle(
          {
            title: `${topic.title} (${fallbackIndex})`,
            body: fullBody,
            date: new Date().toISOString(),
            category: topic.category,
            source_url: uniqueUrl,
            source_name: topic.source_name,
            original_author: null,
            help_link: topic.source_url,
          },
          authors,
          existingSlugs
        );

        existingUrls.add(uniqueUrl);
        count++;
        console.log(`  [Fallback] сгенерирована статья ${count - initialCount}/${stopAt - initialCount}`);
      } catch (err) {
        itemErrors++;
        console.warn(`  ✗ Fallback ошибка: ${err.message}`);
      }
    }
  } else if (count < stopAt) {
    console.log(`\n⚠  Набрано только ${count - initialCount} из ${stopAt - initialCount} — свежих RSS-материалов не хватает (fallback отключён)`);
  }

  const added = count - initialCount;

  if (failedFeeds.length > 0) {
    console.log(`\n📋 Недоступные RSS-источники (${failedFeeds.length}):`);
    for (const f of failedFeeds) {
      console.log(`   • ${f.name}: ${f.error}`);
    }
  }
  if (itemErrors > 0) {
    console.log(`\n⚠  Ошибок при обработке статей: ${itemErrors}`);
  }

  console.log(`\n✅ Готово: ${count} статей (${added} добавлено) в ${storiesDir}`);

  if (process.env.FAIL_ON_ZERO_NEW === 'true' && maxToAdd > 0 && added === 0) {
    console.error('\n❌ FAIL_ON_ZERO_NEW: новых статей не добавлено');
    process.exit(1);
  }
  if (process.env.CI === 'true' && feedSuccess.size === 0 && added === 0) {
    console.error('\n❌ Все RSS-источники недоступны');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
