import fs from 'fs';
import path from 'path';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;

  const code = err?.code ?? err?.cause?.code;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) {
    return true;
  }

  const msg = String(err?.message || err).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('socket') ||
    msg.includes('econnreset') ||
    msg.includes('rate limit')
  );
}

/**
 * Retry async fn with exponential backoff.
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, delays?: number[], label?: string, shouldRetry?: (err: unknown) => boolean }} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    attempts = 3,
    delays = [1000, 3000, 8000],
    label = 'operation',
    shouldRetry = isRetryableError,
  } = opts;

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retry = i < attempts - 1 && shouldRetry(err);
      if (retry) {
        const delay = delays[i] ?? delays[delays.length - 1] ?? 1000;
        console.warn(`  [retry] ${label}: ${err.message} — повтор через ${delay}ms (${i + 2}/${attempts})`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

export function atomicWriteFile(filePath, content, encoding = 'utf-8') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(tmp, content);
  } else {
    fs.writeFileSync(tmp, content, encoding);
  }
  fs.renameSync(tmp, filePath);
}

export function sanitizeForYaml(value) {
  return String(value ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
