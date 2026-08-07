#!/usr/bin/env node
/**
 * Run the real extractor against a live page and print what it found.
 *
 *   node scripts/probe.js linear
 *   node scripts/probe.js linear notion vercel
 *   node scripts/probe.js https://example.com/pricing --kind pricing
 *   node scripts/probe.js --sample 8          random sample from the seed
 *   node scripts/probe.js --all               every seeded company (slow, polite)
 *   node scripts/probe.js linear --json       machine-readable
 *
 * This is the tool that answers "do the selectors actually work", and it is the
 * same code path a crawl runs. Extraction time is reported separately from
 * network time, because they fail for entirely different reasons and lumping
 * them together hides which one just got worse.
 */

import { readFile } from 'node:fs/promises';
import { extract, yieldOf, signalsFor } from '../src/extract/index.js';
import { crawlHeaders, FETCH_TIMEOUT_MS } from '../src/crawl/agent.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const asJson = flags.has('--json');
const forcedKind = argv.includes('--kind') ? argv[argv.indexOf('--kind') + 1] : null;
const sampleN = argv.includes('--sample') ? Number(argv[argv.indexOf('--sample') + 1]) : null;

const seed = JSON.parse(await readFile(new URL('../seed/companies.json', import.meta.url), 'utf8'));
const bySlug = new Map(seed.companies.map((c) => [c.slug, c]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build the list of (label, url, kind, brand) jobs to run. */
function jobs() {
  const out = [];
  const add = (c) => {
    if (!forcedKind || forcedKind === 'home') out.push({ label: `${c.slug}/home`, url: c.homepage_url, kind: 'home', brand: c.name });
    if (c.pricing_url && (!forcedKind || forcedKind === 'pricing')) out.push({ label: `${c.slug}/pricing`, url: c.pricing_url, kind: 'pricing', brand: c.name });
  };

  if (flags.has('--all')) { seed.companies.forEach(add); return out; }
  if (sampleN) {
    const pool = [...seed.companies].sort(() => Math.random() - 0.5).slice(0, sampleN);
    pool.forEach(add);
    return out;
  }
  for (const arg of positional) {
    if (arg === forcedKind) continue;
    if (bySlug.has(arg)) { add(bySlug.get(arg)); continue; }
    if (/^https?:\/\//.test(arg)) {
      const kind = forcedKind ?? (/pricing|plans/.test(arg) ? 'pricing' : 'home');
      out.push({ label: new URL(arg).hostname + new URL(arg).pathname, url: arg, kind, brand: null });
      continue;
    }
    console.error(`unknown slug or url: ${arg}`);
    process.exit(2);
  }
  return out;
}

const list = jobs();
if (list.length === 0) {
  console.error('usage: node scripts/probe.js <slug|url>... [--kind home|pricing] [--sample N] [--all] [--json]');
  process.exit(2);
}

const results = [];

for (const job of list) {
  const t0 = Date.now();
  let body = '', contentType = '', status = 0, finalUrl = job.url, netErr = null;
  try {
    const res = await fetch(job.url, {
      headers: crawlHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 8000),
    });
    status = res.status;
    finalUrl = res.url;
    contentType = res.headers.get('content-type') ?? '';
    body = await res.text();
  } catch (err) {
    netErr = err.name === 'TimeoutError' ? 'timeout' : err.message;
  }
  const netMs = Date.now() - t0;

  // Measure cold and warm separately. The first call in a fresh process pays
  // regex compilation and JIT warm-up; a run sweeps many pages in one process,
  // so the warm number is the one that describes steady state. Reporting only
  // the warm number would be flattering; reporting only the cold one would be
  // wrong.
  const t1 = process.hrtime.bigint();
  const out = netErr ? null : extract(job.kind, body, finalUrl, { brand: job.brand, contentType });
  const coldMs = Number(process.hrtime.bigint() - t1) / 1e6;

  let warmMs = coldMs;
  if (!netErr) {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t = process.hrtime.bigint();
      extract(job.kind, body, finalUrl, { brand: job.brand, contentType });
      samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    samples.sort((a, b) => a - b);
    warmMs = samples[Math.floor(samples.length / 2)];
  }
  const cpuMs = warmMs;

  const row = {
    label: job.label, url: job.url, finalUrl, status, contentType: contentType.split(';')[0],
    bytes: body.length, netMs, cpuMs: Number(cpuMs.toFixed(2)), coldMs: Number(coldMs.toFixed(2)), netErr,
    variant: out?.variant ?? null, lang: out?.lang ?? null,
    yield: out ? yieldOf(out) : 0, expected: signalsFor(job.kind).length,
    signals: out?.signals ?? {},
  };
  results.push(row);

  if (asJson) { await sleep(500); continue; }

  const redirect = finalUrl.replace(/\/$/, '') !== job.url.replace(/\/$/, '') ? `  ->  ${finalUrl}` : '';
  console.log(`\n\x1b[1m${job.label}\x1b[0m  ${job.url}${redirect}`);
  if (netErr) { console.log(`  network: ${netErr}`); await sleep(500); continue; }
  console.log(
    `  http ${status}  ${row.contentType}  ${(body.length / 1024).toFixed(0)}kB  ` +
    `lang=${row.lang ?? '?'}  variant=${row.variant}  ` +
    `net ${netMs}ms  \x1b[36mextract ${row.cpuMs}ms warm / ${row.coldMs}ms cold\x1b[0m  yield ${row.yield}/${row.expected}`
  );
  for (const [name, sig] of Object.entries(row.signals)) {
    if (!sig) { console.log(`    \x1b[31m${name.padEnd(21)}\x1b[0m -`); continue; }
    const v = sig.value.length > 150 ? sig.value.slice(0, 147) + '...' : sig.value;
    console.log(`    \x1b[32m${name.padEnd(21)}\x1b[0m ${v}`);
    console.log(`    ${''.padEnd(21)} \x1b[2m[${sig.method} conf=${sig.confidence}]\x1b[0m`);
  }
  await sleep(500);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const okRows = results.filter((r) => !r.netErr && r.variant === 'html');
  const cpu = okRows.map((r) => r.cpuMs).sort((a, b) => a - b);
  const p = (q) => (cpu.length ? cpu[Math.min(cpu.length - 1, Math.floor(cpu.length * q))] : 0);
  const totalYield = okRows.reduce((s, r) => s + r.yield, 0);
  const totalExpect = okRows.reduce((s, r) => s + r.expected, 0);
  const cold = okRows.map((r) => r.coldMs).sort((a, b) => a - b);
  const pc = (q) => (cold.length ? cold[Math.min(cold.length - 1, Math.floor(cold.length * q))] : 0);
  const maxBytes = Math.max(0, ...okRows.map((r) => r.bytes));
  console.log(
    `\n\x1b[1msummary\x1b[0m  ${okRows.length}/${results.length} pages extracted  ` +
    `signal yield ${totalYield}/${totalExpect} (${((totalYield / Math.max(1, totalExpect)) * 100).toFixed(0)}%)`
  );
  console.log(
    `         extract cpu warm p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  max ${cpu[cpu.length - 1] ?? 0}ms  |  ` +
    `cold p50 ${pc(0.5)}ms  max ${cold[cold.length - 1] ?? 0}ms  |  largest page ${(maxBytes / 1024).toFixed(0)}kB`
  );
}
