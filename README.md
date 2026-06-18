# Шок-Новости

Отдельный статический портал на Astro 6: происшествия, криминал, ДТП и ЧП.

RSS → рерайт 1000–2000 символов → Gemini-картинки → деплой.

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
