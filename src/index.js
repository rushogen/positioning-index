/**
 * Worker entry point.
 *
 * Two responsibilities:
 *   fetch()      serve the public index and its JSON API
 *   scheduled()  run the crawl, one page per tick (see src/scheduled.js)
 *
 * The fetch handler is the one genuinely bound by the free plan's 10ms CPU
 * ceiling, so it does no parsing and no computation worth the name: it reads
 * D1 through the indexes declared in schema.sql and serialises the result.
 * Static assets are served by Cloudflare's asset pipeline before this code runs
 * and cost neither CPU nor a request against the daily quota.
 */

import { scheduled } from './scheduled.js';
import { SIGNALS } from './extract/index.js';
import { USER_AGENT, BOT_NAME, CONTACT_URL } from './crawl/agent.js';
import {
  categoryDistribution, companyDetail, companyHealth, indexStats, listCompanies,
  recentChanges, signalSeries,
} from './db.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // The index updates once a day. Caching hard is what keeps us inside the free
  // tier's 100k requests/day: a popular page is served from Cloudflare's edge
  // cache and never reaches the Worker at all.
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers ?? {}) } });

const fail = (status, message) =>
  json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' } });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(405, 'method not allowed');
    }

    try {
      // ---- crawler disclosure. Linked from our own User-Agent string, so a
      // site operator who greps their logs lands on something useful.
      if (pathname === '/crawler' || pathname === '/crawler.txt') {
        return new Response(crawlerDisclosure(), {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' },
        });
      }

      if (pathname === '/robots.txt') {
        return new Response('User-agent: *\nAllow: /\n', {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' },
        });
      }

      if (!pathname.startsWith('/api/')) {
        // Anything else is a static asset. When the ASSETS binding is present
        // Cloudflare has already tried it; reaching here means a real 404, and
        // we hand back the index so client-side routes still work.
        return env.ASSETS ? env.ASSETS.fetch(new Request(new URL('/', url), request)) : fail(404, 'not found');
      }

      const db = env.DB;
      if (!db) return fail(503, 'database binding missing');

      switch (true) {
        case pathname === '/api/stats': {
          const [stats, categories] = await Promise.all([indexStats(db), categoryDistribution(db)]);
          return json({ ...stats, categories, signals: SIGNALS, generated_at: new Date().toISOString() });
        }

        case pathname === '/api/companies':
          return json({ companies: await listCompanies(db) });

        case pathname === '/api/health':
          return json({ companies: await companyHealth(db) });

        case pathname === '/api/changes':
          return json({
            changes: await recentChanges(db, {
              limit: intParam(url, 'limit', 60),
              signal: url.searchParams.get('signal'),
              slug: url.searchParams.get('company'),
              before: url.searchParams.get('before'),
            }),
          });

        case pathname.startsWith('/api/company/'): {
          const rest = pathname.slice('/api/company/'.length);
          const [slug, maybeSeries, signal] = rest.split('/');
          if (!slug) return fail(400, 'company slug required');

          if (maybeSeries === 'series') {
            if (!signal || !SIGNALS[signal]) return fail(400, `unknown signal; expected one of ${Object.keys(SIGNALS).join(', ')}`);
            return json({ slug, signal, series: await signalSeries(db, slug, signal, { limit: intParam(url, 'limit', 365) }) });
          }

          const detail = await companyDetail(db, slug);
          return detail ? json(detail) : fail(404, `no company with slug "${slug}"`);
        }

        default:
          return fail(404, 'no such endpoint');
      }
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', path: pathname, error: String(err?.stack ?? err) }));
      return fail(500, 'internal error');
    }
  },

  scheduled,
};

function intParam(url, name, fallback) {
  const n = Number.parseInt(url.searchParams.get(name) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function crawlerDisclosure() {
  return `${BOT_NAME} -- crawler disclosure
${'='.repeat(60)}

User-Agent
  ${USER_AGENT}

What it does
  Fetches the publicly accessible homepage and pricing page of the B2B SaaS
  companies listed at ${CONTACT_URL}, and records a small number of short
  factual strings from them: the hero headline and subhead, the category noun,
  the meta title and description, published pricing tier names and prices,
  customer logo names, and quantified marketing claims.

  The purpose is to observe how software companies change their own positioning
  over time. Nothing is republished at length; the index stores short excerpts
  and links back to the source page.

Rate
  At most one request per page per day. At most one request per host per
  invocation. robots.txt is fetched at most once per host per day.

What it honours
  robots.txt per RFC 9309, including per-agent groups, longest-match rule
  precedence, and Crawl-delay.
  Content-Signal declarations (content-signals.org). This crawler indexes; it
  does not train models and does not supply a generative system.
  HTTP 429 and Retry-After.
  If a robots.txt cannot be fetched, or returns 5xx, we do not crawl.

How to stop it
  Add this to your robots.txt:

      User-agent: ${BOT_NAME}
      Disallow: /

  It takes effect within 24 hours, which is the robots.txt cache lifetime.
  Or email the address on ${CONTACT_URL} and the domain will be removed from
  the seed list entirely.

Not collected
  No personal data. No authenticated pages. No form submissions. No pages
  outside the two URLs published per company in seed/companies.json.
`;
}
