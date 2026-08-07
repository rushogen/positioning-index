/**
 * robots.txt parser and matcher tests.
 *
 * Two of these use robots.txt bodies captured live from sites in the seed list,
 * so the parser is pinned against real-world formatting rather than only
 * against textbook examples.
 */

import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import {
  checkUrl, interpretRobotsStatus, isAllowed, parseRobots, patternMatches, selectGroup,
} from '../src/crawl/robots.js';
import { BOT_TOKEN } from '../src/crawl/agent.js';

const U = (p) => `https://example.com${p}`;

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

test('parses groups, rules, crawl-delay and sitemaps', () => {
  const { groups, sitemaps } = parseRobots(`
# a comment
User-agent: *
Disallow: /admin
Allow: /admin/public
Crawl-delay: 2.5

User-agent: BadBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
`);

  assert.deepEqual(groups.get('*').disallow, ['/admin']);
  assert.deepEqual(groups.get('*').allow, ['/admin/public']);
  assert.equal(groups.get('*').crawlDelay, 2.5);
  assert.deepEqual(groups.get('badbot').disallow, ['/']);
  assert.deepEqual(sitemaps, ['https://example.com/sitemap.xml']);
});

test('consecutive User-agent lines share one group', () => {
  const { groups } = parseRobots(`
User-agent: alpha
User-agent: beta
Disallow: /private
`);
  assert.deepEqual(groups.get('alpha').disallow, ['/private']);
  assert.deepEqual(groups.get('beta').disallow, ['/private']);
});

test('an empty Disallow means allow everything and is not stored as a rule', () => {
  const { groups } = parseRobots('User-agent: *\nDisallow:\n');
  assert.deepEqual(groups.get('*').disallow, []);
  assert.equal(isAllowed('User-agent: *\nDisallow:\n', U('/anything')).allowed, true);
});

test('rules before any User-agent line are ignored', () => {
  const { groups } = parseRobots('Disallow: /nope\nUser-agent: *\nAllow: /\n');
  assert.deepEqual(groups.get('*').allow, ['/']);
  assert.equal(groups.size, 1);
});

// ---------------------------------------------------------------------------
// group selection
// ---------------------------------------------------------------------------

test('our own token beats the wildcard group', () => {
  const { groups } = parseRobots(`
User-agent: *
Disallow: /

User-agent: ${BOT_TOKEN}
Allow: /
`);
  const { group, matched } = selectGroup(groups, BOT_TOKEN);
  assert.equal(matched, BOT_TOKEN);
  assert.deepEqual(group.allow, ['/']);
});

test('a site can block us by name and we honour it', () => {
  const body = `User-agent: *\nAllow: /\n\nUser-agent: ${BOT_TOKEN}\nDisallow: /\n`;
  const verdict = isAllowed(body, U('/pricing'));
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.matchedAgent, BOT_TOKEN);
});

test('falls back to the wildcard group when we are not named', () => {
  const { matched } = selectGroup(parseRobots('User-agent: *\nDisallow: /x\n').groups, BOT_TOKEN);
  assert.equal(matched, '*');
});

test('no applicable group at all means no restrictions', () => {
  const v = isAllowed('User-agent: Googlebot\nDisallow: /\n', U('/pricing'));
  assert.equal(v.allowed, true);
});

// ---------------------------------------------------------------------------
// pattern matching
// ---------------------------------------------------------------------------

test('prefix, wildcard and end-anchor patterns', () => {
  assert.equal(patternMatches('/admin', '/admin/users'), true);
  assert.equal(patternMatches('/admin', '/administrator'), true, 'prefix match, per spec');
  assert.equal(patternMatches('/admin/', '/administrator'), false);
  assert.equal(patternMatches('/*.pdf$', '/docs/report.pdf'), true);
  assert.equal(patternMatches('/*.pdf$', '/docs/report.pdf?x=1'), false);
  assert.equal(patternMatches('/a/*/c', '/a/b/c/d'), true);
  assert.equal(patternMatches('/a/*/c$', '/a/b/c'), true);
  assert.equal(patternMatches('/a/*/c$', '/a/b/c/d'), false);
  assert.equal(patternMatches('/', '/anything'), true);
});

test('a hostile wildcard pattern does not blow up', () => {
  const pattern = '/' + '*a'.repeat(200) + '$';
  const path = '/' + 'a'.repeat(4000);
  const started = Date.now();
  patternMatches(pattern, path);
  assert.ok(Date.now() - started < 200, 'matching must stay linear, no regex backtracking');
});

// ---------------------------------------------------------------------------
// rule precedence -- the part everyone gets wrong
// ---------------------------------------------------------------------------

test('the longest matching rule wins, not the first', () => {
  const body = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public\n';
  assert.equal(isAllowed(body, U('/docs/private')).allowed, false);
  assert.equal(isAllowed(body, U('/docs/public/a')).allowed, true);
});

test('Allow wins an exact-length tie', () => {
  const body = 'User-agent: *\nDisallow: /p\nAllow: /p\n';
  const v = isAllowed(body, U('/pricing'));
  assert.equal(v.allowed, true);
  assert.match(v.reason, /at least as specific/);
});

test('rule order in the file does not affect the outcome', () => {
  const a = 'User-agent: *\nAllow: /docs/public\nDisallow: /docs\n';
  const b = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public\n';
  assert.equal(isAllowed(a, U('/docs/public/x')).allowed, isAllowed(b, U('/docs/public/x')).allowed);
});

// ---------------------------------------------------------------------------
// HTTP status handling -- fail closed
// ---------------------------------------------------------------------------

test('robots.txt status codes are interpreted per RFC 9309', () => {
  assert.equal(interpretRobotsStatus(200).usable, true);
  assert.equal(interpretRobotsStatus(404).defaultAllow, true, '404 means no restrictions');
  assert.equal(interpretRobotsStatus(403).defaultAllow, false, '403 is an explicit refusal');
  assert.equal(interpretRobotsStatus(401).defaultAllow, false);
  assert.equal(interpretRobotsStatus(500).defaultAllow, false, '5xx fails closed');
  assert.equal(interpretRobotsStatus(503).defaultAllow, false);
});

test('a robots.txt fetch that throws fails closed', async () => {
  const store = memoryStore();
  const verdict = await checkUrl(U('/'), store, {
    fetchImpl: () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /failing closed/);
});

test('a 5xx robots.txt fails closed', async () => {
  const store = memoryStore();
  const verdict = await checkUrl(U('/'), store, {
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  assert.equal(verdict.allowed, false);
});

test('a 404 robots.txt permits crawling', async () => {
  const store = memoryStore();
  const verdict = await checkUrl(U('/'), store, {
    fetchImpl: async () => new Response('nope', { status: 404 }),
  });
  assert.equal(verdict.allowed, true);
});

// ---------------------------------------------------------------------------
// caching -- one robots.txt request per host per day
// ---------------------------------------------------------------------------

test('robots.txt is fetched once and then served from cache', async () => {
  const store = memoryStore();
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('User-agent: *\nAllow: /\n', { status: 200 }); };

  await checkUrl(U('/'), store, { fetchImpl });
  await checkUrl(U('/pricing'), store, { fetchImpl });
  await checkUrl(U('/about'), store, { fetchImpl });

  assert.equal(calls, 1, 'three page checks must cost exactly one robots.txt request');
});

test('the cache expires and is refetched', async () => {
  const store = memoryStore();
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('User-agent: *\nAllow: /\n', { status: 200 }); };

  const t0 = Date.parse('2026-08-01T00:00:00Z');
  await checkUrl(U('/'), store, { fetchImpl, now: t0 });
  await checkUrl(U('/'), store, { fetchImpl, now: t0 + 25 * 60 * 60 * 1000 });
  assert.equal(calls, 2);
});

test('Crawl-delay is surfaced to the scheduler', async () => {
  const store = memoryStore();
  const verdict = await checkUrl(U('/'), store, {
    fetchImpl: async () => new Response('User-agent: *\nCrawl-delay: 10\nAllow: /\n', { status: 200 }),
  });
  assert.equal(verdict.crawlDelay, 10);
});

// ---------------------------------------------------------------------------
// real captured robots.txt bodies
//
// Verbatim from the live sites, stored in tests/fixtures/. These pin the parser
// against formatting that actually occurs -- Content-Signal lines, a bare
// "Disallow:" among real rules, long per-bot blocklists -- rather than only
// against textbook examples.
// ---------------------------------------------------------------------------

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/robots_${name}.txt`, import.meta.url), 'utf8');

test('real vercel.com robots.txt', () => {
  const body = fixture('vercel_com');
  assert.equal(isAllowed(body, 'https://vercel.com/').allowed, true);
  assert.equal(isAllowed(body, 'https://vercel.com/pricing').allowed, true);
  assert.equal(isAllowed(body, 'https://vercel.com/api/x').allowed, false);
  // A bare "Disallow:" sits among the real rules and must not become a rule.
  assert.equal(isAllowed(body, 'https://vercel.com/anything-else').allowed, true);
  // The longest-match rule must let the OG image route through despite /api/.
  assert.equal(isAllowed(body, 'https://vercel.com/api/og/thing').allowed, true);
});

test('real vercel.com robots.txt declares Content Signals and we read them', () => {
  const v = isAllowed(fixture('vercel_com'), 'https://vercel.com/pricing');
  assert.deepEqual(v.contentSignals, { search: true, 'ai-input': true, 'ai-train': false });
  assert.equal(v.allowed, true, 'search=yes, so an indexing crawler may proceed');
});

test('a site declaring search=no is treated as opted out, Allow rules notwithstanding', () => {
  const body = 'User-Agent: *\nContent-Signal: search=no, ai-train=no\nAllow: /\n';
  const v = isAllowed(body, 'https://example.com/pricing');
  assert.equal(v.allowed, false);
  assert.match(v.reason, /Content-Signal/);
});

test('real notion.com robots.txt', () => {
  const body = fixture('www_notion_com');
  assert.equal(isAllowed(body, 'https://www.notion.com/').allowed, true);
  assert.equal(isAllowed(body, 'https://www.notion.com/pricing').allowed, true);
  assert.equal(isAllowed(body, 'https://www.notion.com/invite/abc').allowed, false);
  // Notion blocks several named crawlers outright. None of those rules may
  // leak into the group that applies to us.
  assert.equal(isAllowed(body, 'https://www.notion.com/', 'ahrefsbot').allowed, false);
  assert.equal(isAllowed(body, 'https://www.notion.com/').allowed, true);
});

test('real linear.app robots.txt', () => {
  const body = fixture('linear_app');
  assert.equal(isAllowed(body, 'https://linear.app/').allowed, true);
  assert.equal(isAllowed(body, 'https://linear.app/pricing').allowed, true);
  assert.equal(isAllowed(body, 'https://linear.app/api/graphql').allowed, false);
  // Allow: /api/og/ is longer than Disallow: /api/ and must win.
  assert.equal(isAllowed(body, 'https://linear.app/api/og/x').allowed, true);
});

test('every seeded homepage path is allowed by its own live robots.txt', async () => {
  // Sanity check that the seed list is not full of URLs we are not permitted to
  // fetch. Runs against the captured fixtures only, so it stays offline.
  for (const [name, url] of [
    ['vercel_com', 'https://vercel.com/'],
    ['www_notion_com', 'https://www.notion.com/'],
    ['linear_app', 'https://linear.app/'],
  ]) {
    assert.equal(isAllowed(fixture(name), url).allowed, true, `${name} homepage must be crawlable`);
  }
});

function memoryStore() {
  const map = new Map();
  return {
    async get(host) { return map.get(host) ?? null; },
    async put(host, rec) { map.set(host, rec); },
  };
}
