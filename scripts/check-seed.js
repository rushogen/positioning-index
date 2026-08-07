#!/usr/bin/env node
/**
 * Seed validator.
 *
 *   node scripts/check-seed.js                          structural checks only (fast, offline)
 *   node scripts/check-seed.js --live                   also make one real request per URL
 *   node scripts/check-seed.js --file <path> [--live]   check a candidate file instead
 *
 * The live mode is deliberately slow. It sends one request at a time with a
 * pause between hosts, using the same User-Agent the crawler uses in
 * production. Running it against 60 companies takes a couple of minutes; that
 * is the correct speed for touching other people's servers.
 *
 * `--file` exists so a proposed expansion can be checked before any of it is
 * promoted into the seed. A candidate file is held to every structural rule the
 * seed is held to, except the company-count range: that range guards against
 * somebody truncating the canonical seed, and a candidate list is legitimately
 * any size. The count is still reported.
 */

import { readFile } from 'node:fs/promises';
import { USER_AGENT } from '../src/crawl/agent.js';

const LIVE = process.argv.includes('--live');
const PAUSE_MS = 400;

const fileFlag = process.argv.indexOf('--file');
const filePath = fileFlag === -1 ? null : process.argv[fileFlag + 1];
if (fileFlag !== -1 && !filePath) {
  console.error('  FAIL  --file needs a path');
  process.exit(1);
}
const CANONICAL = filePath === null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seedPath = CANONICAL
  ? new URL('../seed/companies.json', import.meta.url)
  : new URL(filePath, `file://${process.cwd()}/`);
const seed = JSON.parse(await readFile(seedPath, 'utf8'));
if (!CANONICAL) console.log(`checking candidate file: ${filePath}\n`);

let problems = 0;
const fail = (msg) => { problems++; console.error(`  FAIL  ${msg}`); };

// ---------------------------------------------------------------- structure
const slugs = new Set();
const hosts = new Map();

for (const c of seed.companies) {
  for (const field of ['slug', 'name', 'segment', 'homepage_url']) {
    if (!c[field]) fail(`${c.slug ?? '(no slug)'}: missing ${field}`);
  }
  if (slugs.has(c.slug)) fail(`duplicate slug: ${c.slug}`);
  slugs.add(c.slug);
  if (!/^[a-z0-9-]+$/.test(c.slug)) fail(`${c.slug}: slug must be [a-z0-9-]`);

  for (const key of ['homepage_url', 'pricing_url']) {
    const raw = c[key];
    if (!raw) continue;
    let u;
    try { u = new URL(raw); } catch { fail(`${c.slug}: ${key} is not a URL: ${raw}`); continue; }
    if (u.protocol !== 'https:') fail(`${c.slug}: ${key} must be https`);
    if (u.search) fail(`${c.slug}: ${key} must not carry a query string`);
    if (u.hash) fail(`${c.slug}: ${key} must not carry a fragment`);
    hosts.set(u.hostname, (hosts.get(u.hostname) ?? 0) + 1);
  }
}

console.log(`structure: ${seed.companies.length} companies, ${slugs.size} unique slugs, ${hosts.size} distinct hosts`);

const count = seed.companies.length;
if (CANONICAL && (count < 40 || count > 260)) {
  fail(`company count ${count} outside the intended 40-260 range`);
}

if (!LIVE) {
  console.log(problems ? `\n${problems} problem(s)` : '\nok (structural only -- pass --live to hit the network)');
  process.exit(problems ? 1 : 0);
}

// --------------------------------------------------------------------- live
console.log(`\nlive check as: ${USER_AGENT}\n`);

const rows = [];
for (const c of seed.companies) {
  for (const [kind, url] of [['home', c.homepage_url], ['pricing', c.pricing_url]]) {
    if (!url) continue;
    const started = Date.now();
    let status = 0, finalUrl = url, note = '', bytes = 0;
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      status = res.status;
      finalUrl = res.url;
      const body = await res.text();
      bytes = body.length;
      if (!/<html/i.test(body)) note = 'non-HTML body';
      if (bytes < 2000) note = note || 'suspiciously small body';
    } catch (err) {
      note = err.name === 'TimeoutError' ? 'timeout' : err.message;
    }
    const redirected = finalUrl.replace(/\/$/, '') !== url.replace(/\/$/, '');
    const ok = status >= 200 && status < 300 && !note;
    rows.push({ slug: c.slug, kind, url, status, bytes, redirected, finalUrl, note, ok });
    console.log(
      `${ok ? ' ok ' : 'WARN'}  ${String(status).padEnd(3)}  ${String(bytes).padStart(7)}b  ` +
      `${c.slug}/${kind}${redirected ? `  -> ${finalUrl}` : ''}${note ? `  (${note})` : ''}` +
      `  ${Date.now() - started}ms`
    );
    await sleep(PAUSE_MS);
  }
}

const bad = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - bad.length}/${rows.length} URLs returned usable HTML`);
if (bad.length) {
  console.log('\nneeds attention:');
  for (const r of bad) console.log(`  ${r.slug}/${r.kind}  ${r.status}  ${r.note}  ${r.url}`);
}
process.exit(problems ? 1 : 0);
