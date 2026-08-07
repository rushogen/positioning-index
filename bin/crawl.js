#!/usr/bin/env node
/**
 * The crawler, as a command.
 *
 *   npm run crawl                       the most overdue batch (default 12 pages)
 *   npm run crawl -- --company linear   one company, both its pages
 *   npm run crawl -- --all              every target in the seed list
 *   npm run crawl -- --dry-run          fetch and extract, write nothing at all
 *   npm run crawl -- --limit 30         a bigger batch
 *
 * This is the entire operational surface. There is no daemon, no scheduler
 * process, no hosted anything: a run happens when a person or a workflow asks
 * for one, and then the process exits. GitHub Actions runs this same file with
 * the same arguments -- see .github/workflows/crawl.yml.
 *
 * Exit codes: 0 if the run completed (whatever it found), 1 if the run itself
 * could not be carried out. "Every page was blocked" is a successful run with an
 * interesting result, not a failure; failing the job for it would train the
 * operator to ignore red builds.
 */

import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { FileStore, fileRobotsStore, memoryRobotsStore } from '../src/store/files.js';
import { commitMessage, runCrawl } from '../src/runner.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

if (has('--help') || has('-h')) {
  console.log(`
  npm run crawl                     crawl the most overdue targets
  npm run crawl -- --company linear crawl one company
  npm run crawl -- --all            crawl every target
  npm run crawl -- --dry-run        fetch and extract, write nothing
  npm run crawl -- --limit 30       change the batch size (default 12)
  npm run crawl -- --data ./data    change the data directory
`);
  process.exit(0);
}

const company = value('--company');
const mode = company ? 'company' : has('--all') ? 'all' : 'batch';
const limit = Number.parseInt(value('--limit', '12'), 10) || 12;
const dryRun = has('--dry-run');
const dataDir = value('--data', join(ROOT, 'data'));

const seed = JSON.parse(await readFile(join(ROOT, 'seed', 'companies.json'), 'utf8'));
const store = new FileStore(dataDir);
if (!dryRun) await store.init();

// A dry run must leave no trace, including no robots.txt cache write.
const robotsStore = dryRun ? memoryRobotsStore() : fileRobotsStore(join(ROOT, '.cache', 'robots.json'));

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

let n = 0;
const onResult = (r) => {
  n++;
  const good = r.status === 'ok' || r.status === 'unchanged';
  console.log(
    `  ${String(n).padStart(3)}  ${good ? GREEN : YELLOW}${r.status.padEnd(18)}${OFF}` +
    `${`${r.slug}/${r.kind}`.padEnd(26)} ` +
    `${(r.yield ?? '').padEnd(7)} ` +
    `${r.events ? `${CYAN}${r.events} change(s)${OFF} ` : ''}` +
    `${r.parser_faults ? `${r.parser_faults} fault(s) ` : ''}` +
    `${r.reason ? `${DIM}${String(r.reason).slice(0, 76)}${OFF}` : ''}`
  );
};

console.log(
  `\n  positioning-index  ${mode === 'company' ? `company:${company}` : mode}` +
  `${dryRun ? '  (dry run: nothing will be written)' : ''}\n`
);

let outcome;
try {
  outcome = await runCrawl({
    store,
    seed,
    robotsStore,
    mode,
    company,
    limit,
    dryRun,
    trigger: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
    onResult,
  });
} catch (err) {
  console.error(`\n  the run could not be carried out: ${err?.message ?? err}\n`);
  process.exit(1);
}

const { run } = outcome;

if (run.targets === 0) {
  console.log('  nothing is due. The run is still recorded, so the gap in the archive is explained.');
}

const message = commitMessage(run);

console.log(
  `\n  ${run.targets} target(s): ${run.ok} ok, ${run.unchanged} unchanged, ` +
  `${run.blocked} blocked, ${run.error} error, ${run.structure} restructured` +
  `\n  ${run.changes} change event(s), ${run.parser_faults} parser fault(s), ` +
  `${run.observations} observation line(s) ${dryRun ? 'would be' : ''} written` +
  `\n  ${DIM}${message}${OFF}\n`
);

// GitHub Actions reads these to build the commit and decide whether to push.
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, [
    `commit_message=${message}`,
    `targets=${run.targets}`,
    `changes=${run.changes}`,
    `blocked=${run.blocked}`,
    `errors=${run.error}`,
    '',
  ].join('\n'), 'utf8');
}
