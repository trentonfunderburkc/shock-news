# Шок-Новости

Отдельный статический портал на Astro 6: происшествия, криминал, ДТП и ЧП.

RSS → рерайт 1000–2000 символов → Gemini-картинки → деплой.

## Деплой на Vercel

1. Import репозитория на [vercel.com/new](https://vercel.com/new) → Deploy
2. **Settings → Environment Variables** (Production):

| Переменная | Значение |
|---|---|
| `SITE_URL` | `https://shocknews.space` |
| `PUBLIC_ENABLE_METRIKA` | `true` |
| `PUBLIC_YANDEX_METRIKA_ID` | ваш ID |
| `ANDROID_REDIRECT_ENABLED` | `true` |
| `ANDROID_REDIRECT_URL` | `https://ваш-сайт.ru` |

**Android-редirect:** только телефоны (`Android` + `Mobile`). iOS, desktop и планшеты остаются на shocknews.space. После смены env — **Redeploy**. Сборка не трогает статьи (RSS/AI не запускаются).

## Источники

- МК — Происшествия
- Lenta.ru — Силовые структуры
- АиФ — Происшествия
- Mail.ru — Происшествия

Война, политика, дроны и ВСУ отфильтровываются.

## Команды

```bash
npm install
npm run dev
npm run fetch:articles          # новые статьи
npm run fetch:articles:reset    # пересобрать всё (--confirm-reset)
npm run setup:content           # авторы + статьи + комментарии
```

## Контент

- `rss-sources.json` — ленты
- `scripts/fetch-articles.js` — фильтры и рерайт
- `src/data/site.json` — бренд и рубрики

Ключи API — в `.env` (скопирован из основного проекта).
