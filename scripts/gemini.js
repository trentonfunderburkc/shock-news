import axios from 'axios';
import { atomicWriteFile, withRetry } from './lib/retry.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const API_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || '60000', 10);

export function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === '...' || key.startsWith('YOUR_')) return null;
  return key;
}

export function isGeminiConfigured() {
  return !!getGeminiApiKey();
}

export function getGeminiTextModel() {
  return process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
}

export function getGeminiImageModel() {
  return process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
}

export async function geminiGenerateText({ system, user, model = getGeminiTextModel() }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `${API_BASE}/models/${model}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: 2048 },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const res = await withRetry(
    () =>
      axios.post(`${url}?key=${encodeURIComponent(apiKey)}`, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: API_TIMEOUT_MS,
      }),
    { attempts: 3, label: `Gemini ${model}` }
  );

  const parts = res.data?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join('')
    .trim();
  if (!text) {
    throw new Error('Gemini: empty text response');
  }
  return text;
}

export async function geminiGenerateImage(prompt, destPath, model = getGeminiImageModel()) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `${API_BASE}/models/${model}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  const res = await withRetry(
    () =>
      axios.post(`${url}?key=${encodeURIComponent(apiKey)}`, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
      }),
    { attempts: 2, label: `Gemini Image ${model}` }
  );

  const parts = res.data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      atomicWriteFile(destPath, Buffer.from(inline.data, 'base64'));
      return true;
    }
  }

  const reason = res.data?.candidates?.[0]?.finishReason || res.data?.promptFeedback?.blockReason;
  throw new Error(`Gemini: no image in response${reason ? ` (${reason})` : ''}`);
}
