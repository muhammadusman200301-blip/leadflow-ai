// fetch with timeout and retries. Retries only on network errors, 429 and 5xx,
// so a bad request (4xx) fails fast instead of being sent again.

export type FetchLike = typeof fetch;

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export async function requestJson<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number; fetchImpl?: FetchLike } = {},
): Promise<T> {
  const { timeoutMs = 10_000, retries = 3, fetchImpl = fetch, ...rest } = init;
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...rest, signal: controller.signal });
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;

      const retryable = res.status === 429 || res.status >= 500;
      lastError = new HttpError(res.status, text, url);
      if (!retryable) throw lastError;

      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
      if (attempt < retries) await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
    attempt++;
  }
  throw lastError;
}

function backoff(attempt: number): number {
  const base = 250 * 2 ** attempt; // 250ms, 500ms, 1s, 2s
  return base + Math.floor(Math.random() * 100);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
