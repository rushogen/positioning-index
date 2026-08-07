#!/usr/bin/env node
/**
 * Withdraw a change event that should never have been published.
 *
 *   node bin/retract.js --slug notion --signal pricing_entry_price \
 *     --detected-at 2026-08-07T11:18:26Z \
 *     --reason "..." --correction CORRECTIONS.md#2026-08-07-notion-currency
 *
 * A retraction is an append to data/events.ndjson, not an edit and not a
 * deletion. The wrong claim stays in the file exactly as it was published; a
 * later line says it was withdrawn, why, and when. Deleting it would be the one
 * thing an archive whose whole pitch is "check this against a history nobody can
 * quietly rewrite" must never do -- and a reader who acted on the false event
 * deserves to find out that it was withdrawn, not to find that it never existed.
 *
 * The public feed (src/report.js) shows only events that have not been
 * retracted. The retraction itself is published at docs/api/retractions.json and
 * written up in CORRECTIONS.md, so the correction is as visible as the error.
 *
 * There is no un-retract. Add another line if you must; the file only grows.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { FileStore, isRetraction, iso } from '../src/store/files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

if (argv.includes('--help') || argv.includes('-h') || !argv.length) {
  console.log(`
  node bin/retract.js --slug <slug> --signal <signal> --detected-at <iso>
                      --reason "<why it was wrong>"
                      [--correction CORRECTIONS.md#anchor]
                      [--data ./data] [--dry-run]

  Appends a retraction line to data/events.ndjson. Nothing is ever removed.
`);
  process.exit(argv.length ? 0 : 1);
}

const slug = value('--slug');
const signal = value('--signal');
const detectedAt = value('--detected-at');
const reason = value('--reason');
const correction = value('--correction', 'CORRECTIONS.md');
const dataDir = value('--data', join(ROOT, 'data'));
const dryRun = argv.includes('--dry-run');

for (const [name, v] of [['--slug', slug], ['--signal', signal], ['--detected-at', detectedAt], ['--reason', reason]]) {
  if (!v) {
    console.error(`  ${name} is required. A retraction without a stated reason is a deletion with extra steps.`);
    process.exit(1);
  }
}

const store = new FileStore(dataDir);
const rows = await store.readEvents();

const target = rows.find((e) => !isRetraction(e) && e.slug === slug && e.signal === signal && e.detected_at === detectedAt);
if (!target) {
  console.error(`  no published event for ${slug}/${signal} at ${detectedAt}. Refusing to retract something that was never claimed.`);
  process.exit(1);
}
if (rows.some((e) => isRetraction(e) && e.slug === slug && e.signal === signal && e.detected_at === detectedAt)) {
  console.error('  already retracted; nothing to do.');
  process.exit(0);
}

const record = {
  retracted_at: iso(),
  slug,
  signal,
  detected_at: detectedAt,
  name: target.name ?? null,
  kind: target.kind ?? null,
  summary_retracted: target.summary ?? null,
  reason,
  correction,
};

if (dryRun) {
  console.log(`  would append: ${JSON.stringify({ ...record, record: 'retraction' })}`);
  process.exit(0);
}

await store.init();
await store.appendRetraction(record);

// Reproduce the METHODOLOGY-mandated shape of the note for the operator, so the
// CORRECTIONS.md entry and the data cannot drift apart unnoticed.
console.log(
  `  retracted ${slug}/${signal} @ ${detectedAt}\n` +
  `    was: ${target.summary ?? '(no summary)'}\n` +
  `    why: ${reason}\n` +
  `    see: ${correction}\n` +
  '  Run `npm run build` to regenerate docs/ so the public feed drops it.'
);

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
if (!pkg.scripts?.build) console.warn('  (no build script found; docs/ will not update on its own)');
