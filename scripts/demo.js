#!/usr/bin/env node
/**
 * Run the whole thing locally, against the real internet, without Cloudflare.
 *
 *   node scripts/demo.js --fresh --crawl 12    reset, crawl 12 targets, serve
 *   node scripts/demo.js --crawl 20            crawl 20 more, serve
 *   node scripts/demo.js                       just serve what is already stored
 *   node scripts/demo.js --crawl 12 --no-serve crawl only
 *
 * The database is real SQLite (D1 is SQLite), the schema is the real
 * schema.sql, the crawler, extractor and diff engine are the real ones, and the
 * HTTP handler routes to the same functions src/index.js does. The only thing
 * missing is Cloudflare.
 *
 * It crawls politely: one target at a time, with a pause between ticks, which
 * is the same shape as the production cron. Crawling 12 targets takes about a
 * minute.
 */

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestD1 } from './lib/sqlite-d1.js';
import { tick, daily } from '../src/scheduled.js';
import { SIGNALS } from '../src/extract/index.js';
import {
  categoryDistribution, companyDetail, companyHealth, indexStats, listCompanies,
  recentChanges, signalSeries,
} from '../src/db.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const num = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : Number(argv[i + 1]) || d; };

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DB_DIR = join(ROOT, '.demo');
const DB_PATH = join(DB_DIR, 'index.db');
const PORT = num('--port', 8787);
const PAUSE_MS = num('--pause', 1500);

await mkdir(DB_DIR, { recursive: true });

// --------------------------------------------------------------- database

const fresh = has('--fresh');
if (fresh) {
  const { rm } = await import('node:fs/promises');
  await rm(DB_PATH, { force: true });
}

const db = new TestD1();
db.db.close();

// Reopen file-backed rather than in-memory so a crawl survives a restart.
const { DatabaseSync } = await import('node:sqlite');
const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA foreign_keys = ON');
const D1 = Object.create(TestD1.prototype);
D1.db = raw;

const hasSchema = raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='companies'").get().n;
if (!hasSchema) {
  raw.exec(await readFile(join(ROOT, 'schema.sql'), 'utf8'));
  const { buildSeedSql } = await import('./build-seed-sql.js');
  raw.exec(await buildSeedSql());
  console.log('schema + seed applied');
}

const env = { DB: D1, DAILY_CRON: '5 0 * * *' };

// ------------------------------------------------------------------ crawl

const toCrawl = num('--crawl', 0);
if (toCrawl > 0) {
  await daily(env);
  console.log(`crawling ${toCrawl} target(s), one at a time, ${PAUSE_MS}ms apart\n`);

  for (let i = 0; i < toCrawl; i++) {
    // Make the next target due, mimicking a cron tick arriving on schedule.
    D1.db.prepare("UPDATE targets SET next_due_at = ? WHERE id = (SELECT id FROM targets WHERE enabled = 1 ORDER BY next_due_at LIMIT 1)")
      .run(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

    let r;
    try {
      r = await tick(env);
    } catch (err) {
      console.log(`  ${String(i + 1).padStart(3)}  CRASH  ${err.message}`);
      continue;
    }
    if (r.action === 'idle') { console.log('  nothing due'); break; }

    const bad = r.status !== 'ok' && r.status !== 'unchanged';
    const colour = bad ? '\x1b[33m' : '\x1b[32m';
    console.log(
      `  ${String(i + 1).padStart(3)}  ${colour}${r.status.padEnd(18)}\x1b[0m` +
      `${(r.slug + '/' + r.kind).padEnd(26)} ` +
      `${(r.yield ?? '').padEnd(7)} ` +
      `${r.events ? `\x1b[36m${r.events} change(s)\x1b[0m ` : ''}` +
      `${r.parserFaults ? `${r.parserFaults} fault(s) ` : ''}` +
      `${r.reason ? `\x1b[2m${r.reason.slice(0, 70)}\x1b[0m` : ''}`
    );
    await new Promise((res) => setTimeout(res, PAUSE_MS));
  }

  const stats = await indexStats(D1);
  console.log(
    `\nstored: ${stats.observations} observations, ${stats.changes} change events, ` +
    `${stats.fetches_24h} fetches in 24h (${stats.blocked_24h} blocked, ${stats.errors_24h} errors)`
  );
}

if (has('--no-serve')) process.exit(0);

// ------------------------------------------------------------------ serve

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const sendJson = (res, body, status = 200) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/api/stats') {
      const [stats, categories] = await Promise.all([indexStats(D1), categoryDistribution(D1)]);
      return sendJson(res, { ...stats, categories, signals: SIGNALS, generated_at: new Date().toISOString() });
    }
    if (p === '/api/companies') return sendJson(res, { companies: await listCompanies(D1) });
    if (p === '/api/health') return sendJson(res, { companies: await companyHealth(D1) });
    if (p === '/api/changes') {
      return sendJson(res, {
        changes: await recentChanges(D1, {
          limit: Number(url.searchParams.get('limit')) || 60,
          signal: url.searchParams.get('signal'),
          slug: url.searchParams.get('company'),
        }),
      });
    }
    if (p.startsWith('/api/company/')) {
      const [slug, maybe, signal] = p.slice('/api/company/'.length).split('/');
      if (maybe === 'series') return sendJson(res, { slug, signal, series: await signalSeries(D1, slug, signal) });
      const detail = await companyDetail(D1, slug);
      return detail ? sendJson(res, detail) : sendJson(res, { error: 'not found' }, 404);
    }
    if (p.startsWith('/api/')) return sendJson(res, { error: 'no such endpoint' }, 404);

    // Static assets, with traversal blocked.
    const rel = normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, 'public', rel);
    if (!file.startsWith(join(ROOT, 'public'))) { res.writeHead(403); return res.end('forbidden'); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      return res.end(body);
    } catch {
      const shell = await readFile(join(ROOT, 'public', 'index.html'));
      res.writeHead(404, { 'content-type': MIME['.html'] });
      return res.end(shell);
    }
  } catch (err) {
    console.error(err);
    return sendJson(res, { error: String(err.message) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n  The B2B SaaS Positioning Index -- local\n  http://localhost:${PORT}\n`);
  console.log('  ctrl-c to stop\n');
});
