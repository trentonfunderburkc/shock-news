import OpenAI from 'openai';
import { withRetry } from './lib/retry.js';
import { geminiGenerateText, isGeminiConfigured } from './gemini.js';

const API_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || '60000', 10);

const SCENE_SYSTEM_PROMPT =
  'Опиши ОДНУ конкретную фотографию для иллюстрации русскоязычной новости о происшествии или криминале. Ответ на английском, 2-3 предложения. Сцена должна соответствовать заголовку: ДТП на дороге, пожар у здания, полиция у оцепления, суд, следователи на месте ЧП и т.п. Без крови, без трупов, без оружия в кадре. Локация: Россия. Стиль: любительское фото с телефона для регионального СМИ. В кадре НЕТ текста, вывесок, надписей.';

export function extractSceneFromTitle(title) {
  const t = title.toLowerCase();
  const scenes = [
    [/дтп|авар|столкновен|наезд|фургон|маршрутк/i, 'damaged cars on Russian regional road after accident, police tape in background, overcast sky, documentary phone photo'],
    [/пожар|сгорел|задымлен|полыха/i, 'smoke rising from building in Russian city, fire trucks nearby, crowd at distance, no flames close-up'],
    [/убий|труп|тело|найден|пропал/i, 'police officers at cordoned area in Russian town, winter coats, yellow tape, somber documentary angle'],
    [/суд|приговор|сизо|арест|задерж/i, 'Russian courthouse exterior or police station entrance, people walking past, grey architecture, candid shot'],
    [/мошен|ограб|похитил|разбой/i, 'bank or ATM area in Russia, security camera angle feel, ordinary street, muted colors'],
    [/дтп|утонул|утопл|лодк/i, 'rescue workers near water in Russia, boats on shore, emergency scene from distance'],
    [/взрыв|чп|чрезвычай/i, 'emergency services at incident site in Russia, ambulances, cordon, documentary phone photo'],
    [/драк|избил|напад/i, 'empty urban alley or courtyard in Russian city, evening light, tense atmosphere without people fighting'],
  ];
  for (const [pattern, scene] of scenes) {
    if (pattern.test(t)) return scene;
  }
  return 'Russian city street with police tape and onlookers at incident scene, documentary phone photo, overcast';
}

export function photoRealismWrapper(sceneDescription) {
  return [
    sceneDescription,
    'Must look like an unedited candid photograph, NOT illustration, NOT digital art, NOT CGI, NOT painting.',
    'Shot on an old smartphone in Russia, 2019: soft focus, slight motion blur, JPEG compression, desaturated muted colors.',
    'Flat overcast daylight or dim street light — no studio lighting, no golden hour glamour, no HDR.',
    'Awkward framing, subject off-center, background clutter, mundane reality.',
    'Muted palette: grey, brown, olive, beige — no oversaturated colors.',
    'Natural skin with pores and imperfections, no airbrushing, no plastic smoothness.',
    'FORBIDDEN: blood, gore, corpses, weapons, text, letters, numbers, signs, banners, logos, labels, watermarks.',
    'FORBIDDEN: stock photo poses, perfect symmetry, lens flare, bokeh balls, AI gloss, painterly look.',
  ].join(' ');
}

async function openAiImageScene(apiKey, baseURL, model, provider, title, category, body) {
  const response = await withRetry(
    async () => {
      const client = new OpenAI({ apiKey, baseURL, timeout: API_TIMEOUT_MS, maxRetries: 0 });
      return client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SCENE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Заголовок: ${title}\nКатегория: ${category}\nСодержание: ${body.slice(0, 400) || title}`,
          },
        ],
        max_tokens: 180,
      });
    },
    { attempts: 3, label: `${provider} Image Prompt` }
  );
  return response.choices[0]?.message?.content?.trim();
}

export async function aiImageScene(title, category, body) {
  const userPrompt = `Заголовок: ${title}\nКатегория: ${category}\nСодержание: ${body.slice(0, 400) || title}`;

  if (isGeminiConfigured()) {
    try {
      const scene = await geminiGenerateText({ system: SCENE_SYSTEM_PROMPT, user: userPrompt });
      if (scene && scene.length > 40) {
        console.log(`  [Gemini Image Prompt] ${scene.slice(0, 70)}…`);
        return scene;
      }
    } catch (err) {
      console.warn(`  [Gemini Image Prompt] ${err.message}`);
    }
  }

  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const textProviders = [];
  if (deepseekKey && deepseekKey !== 'sk-...') {
    textProviders.push({
      provider: 'DeepSeek',
      apiKey: deepseekKey,
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
  }
  if (openaiKey && openaiKey !== 'sk-...') {
    textProviders.push({ provider: 'OpenAI', apiKey: openaiKey, model: 'gpt-4o-mini' });
  }

  for (const { provider, apiKey, baseURL, model } of textProviders) {
    try {
      const scene = await openAiImageScene(apiKey, baseURL, model, provider, title, category, body);
      if (scene && scene.length > 40) {
        console.log(`  [${provider} Image Prompt] ${scene.slice(0, 70)}…`);
        return scene;
      }
    } catch (err) {
      console.warn(`  [${provider} Image Prompt] ${err.message}`);
    }
  }

  return null;
}

export async function buildImagePrompt(title, category, body = '') {
  const aiScene = await aiImageScene(title, category, body);
  const scene = aiScene || extractSceneFromTitle(`${title} ${body}`);
  return photoRealismWrapper(scene);
}
