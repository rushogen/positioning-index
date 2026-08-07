/**
 * The polite fetcher.
 *
 * One page, one request, fully classified. The classification is the point:
 * every outcome maps onto exactly one of the statuses stored in
 * `fetches.status`, and a caller can never be left guessing whether silence
 * meant "nothing changed" or "we never got there".
 *
 *   ok         2xx, HTML body, ready to extract
 *   unchanged  304, or a body byte-identical to last time
 *   blocked    robots.txt says no, or the server refuses an identified client
 *              (401/403/429), or it answers with a non-human variant
 *   error      transport failure, timeout, 5xx, unexpected 4xx, empty body
 *
 * Politeness, concretely:
 *   - one request per URL per day, and at most one URL per invocation
 *   - robots.txt consulted first, cached 24h, failing closed
 *   - Crawl-delay honoured by the scheduler when setting next_due_at
 *   - conditional requests (If-None-Match / If-Modified-Since) so an unchanged
 *     page costs the origin a 304 and no body
 *   - a truthful User-Agent with a contact URL
 *   - response body capped, so a hostile or broken origin cannot exhaust us
 */

import { FETCH_TIMEOUT_MS, MAX_BODY_BYTES, MIN_HOST_INTERVAL_MS, crawlHeaders } from './agent.js';
import { checkUrl } from './robots.js';
import { fnv1a } from '../hash.js';

/**
 * Read at most `limit` bytes of a response body.
 *
 * Streaming rather than res.text() so a 50MB response from a misbehaving origin
 * costs us 1.5MB of memory and then a cancel, not 50MB.
 */
async function readCapped(res, limit = MAX_BODY_BYTES) {
  if (!res.body) return { body: await res.text(), truncated: false };

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        out += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (bytes - limit))), { stream: false });
        truncated = true;
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
    if (!truncated) out += decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }

  return { body: out, truncated, bytes };
}

/**
 * Fetch one page.
 *
 * @param {string} url
 * @param {object} opts
 * @param {object} opts.robotsStore  { get(host), put(host, rec) }
 * @param {string|null} opts.etag
 * @param {string|null} opts.lastModified
 * @param {string|null} opts.contentHash  hash of the previous body
 * @param {function} [opts.fetchImpl]
 * @param {number} [opts.now]
 */
export async function fetchPage(url, {
  robotsStore,
  etag = null,
  lastModified = null,
  contentHash = null,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const started = Date.now();
  const base = { url, finalUrl: url, httpStatus: null, body: null, contentType: '', bytes: 0, durationMs: 0, robots: null };
  const done = (extra) => ({ ...base, ...extra, durationMs: Date.now() - started });

  // ---- 1. May we?
  let robots;
  try {
    robots = await checkUrl(url, robotsStore, { fetchImpl, now });
  } catch (err) {
    return done({ status: 'error', reason: `robots check failed: ${err?.message ?? err}` });
  }
  base.robots = robots;

  if (!robots.allowed) {
    return done({ status: 'blocked', reason: `robots.txt: ${robots.reason}` });
  }

  // ---- 2. Ask, conditionally.
  const headers = crawlHeaders();
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  let res;
  try {
    res = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `timeout after ${FETCH_TIMEOUT_MS}ms`
      : `network error: ${err?.message ?? err}`;
    return done({ status: 'error', reason });
  }

  base.httpStatus = res.status;
  base.finalUrl = res.url || url;
  base.contentType = res.headers.get('content-type') ?? '';

  // ---- 3. Classify.
  if (res.status === 304) {
    return done({
      status: 'unchanged', reason: 'origin returned 304 Not Modified',
      etag: res.headers.get('etag') ?? etag,
      lastModified: res.headers.get('last-modified') ?? lastModified,
    });
  }

  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 451) {
    // Not an error on our side. The server has seen who we are and declined.
    // 429 in particular is a request to back off, and the scheduler does.
    return done({
      status: 'blocked',
      reason: `HTTP ${res.status}: the origin refuses identified automated clients`,
      retryAfter: parseRetryAfter(res.headers.get('retry-after')),
    });
  }

  if (res.status >= 400) {
    return done({ status: 'error', reason: `HTTP ${res.status}` });
  }

  if (res.status < 200 || res.status >= 300) {
    return done({ status: 'error', reason: `unexpected HTTP ${res.status}` });
  }

  let read;
  try {
    read = await readCapped(res);
  } catch (err) {
    return done({ status: 'error', reason: `body read failed: ${err?.message ?? err}` });
  }

  const body = read.body ?? '';
  if (body.length === 0) {
    return done({ status: 'error', reason: 'empty response body' });
  }

  const hash = fnv1a(normaliseForHash(body));

  // ---- 4. Byte-identical to last time. Skip extraction entirely; this is the
  // common case and the cheapest possible path through the scheduler.
  if (contentHash && hash === contentHash) {
    return done({
      status: 'unchanged', reason: 'body identical to the previous fetch',
      body, contentHash: hash, bytes: body.length, truncated: read.truncated,
      etag: res.headers.get('etag') ?? null,
      lastModified: res.headers.get('last-modified') ?? null,
    });
  }

  return done({
    status: 'ok',
    reason: null,
    body,
    contentHash: hash,
    bytes: body.length,
    truncated: read.truncated,
    etag: res.headers.get('etag') ?? null,
    lastModified: res.headers.get('last-modified') ?? null,
  });
}

/**
 * Strip the parts of a page that change on every request but mean nothing:
 * CSRF tokens, build ids, nonces, timestamps. Without this, roughly every page
 * would look "changed" every single day and the content hash would be useless
 * as a skip signal.
 */
export function normaliseForHash(body) {
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\b(?:nonce|csrf[-_]?token|build[-_]?id|deployment[-_]?id|request[-_]?id|trace[-_]?id)\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 400_000);
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.min(seconds, 86_400);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, Math.min(86_400, Math.round((when - Date.now()) / 1000)));
  return null;
}

/**
 * When should this target be attempted again?
 *
 * Success is a plain daily cadence. Failure backs off exponentially so a site
 * that is down, or that has decided it does not want us, stops costing either
 * side anything. A `blocked` verdict backs off hardest: the answer was not
 * "try later", it was "no".
 */
export function nextDueAt({ status, consecutiveFailures, crawlDelay = null, retryAfter = null, now = Date.now() }) {
  const DAY = 86_400_000;

  if (status === 'ok' || status === 'unchanged') {
    // Spread the sweep across the day rather than stampeding at midnight.
    return new Date(now + DAY - 30 * 60_000 + Math.floor(Math.random() * 60 * 60_000));
  }

  const n = Math.max(1, consecutiveFailures);

  if (status === 'blocked') {
    if (retryAfter) return new Date(now + Math.max(retryAfter * 1000, 60 * 60_000));
    // 1d, 2d, 4d, 8d, capped at 30d. We keep checking, because a block is
    // sometimes a WAF rule someone will fix, but we stop being a nuisance.
    return new Date(now + Math.min(DAY * 2 ** (n - 1), 30 * DAY));
  }

  // Errors: 15min, 30min, 1h, 2h ... capped at one day.
  const backoff = Math.min(15 * 60_000 * 2 ** (n - 1), DAY);
  const delayFloor = Math.max(MIN_HOST_INTERVAL_MS, (crawlDelay ?? 0) * 1000);
  return new Date(now + Math.max(backoff, delayFloor));
}
