#!/usr/bin/env node
/**
 * Generate docs/ from data/.
 *
 *   npm run build
 *
 * GitHub Pages serves docs/ on the default branch, so publishing is a commit
 * and nothing else. There is no server, so there is no API: every "endpoint"
 * the page reads is a file written here, and every path in the page is relative
 * so the site works at https://user.github.io/positioning-index/ exactly as it
 * would at a domain root.
 *
 * DETERMINISM
 * -----------
 * Running this twice against the same data/ must produce byte-identical docs/.
 * If it did not, every crawl commit would carry a spurious site diff and the
 * history would stop being readable. Two rules keep it honest:
 *
 *   - no `new Date()` anywhere in the output. The report is computed "as of"
 *     the last run in data/runs.ndjson, which is also what makes the 7- and
 *     30-day change counts reproducible.
 *   - every collection is explicitly sorted before it is written.
 *
 * NO THIRD PARTIES
 * ----------------
 * Nothing here emits a reference to another origin: no CDN, no web font, no
 * analytics, no embed. Partly hygiene, mostly the law the author works under --
 * TDDDG section 25 makes reading or storing anything on a visitor's device
 * conditional on consent, and fetching a font from someone else's server
 * discloses the visitor's IP to them. The simplest way to need no consent
 * dialogue is to need no third party.
 */

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { FileStore } from '../src/store/files.js';
import { SIGNALS } from '../src/extract/index.js';
import { BOT_NAME, CONTACT_URL, USER_AGENT } from '../src/crawl/agent.js';
import {
  categoryDistribution, companyDetail, companyHealth, indexStats, partitionEvents, recentChanges,
} from '../src/report.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const value = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

const dataDir = value('--data', join(ROOT, 'data'));
const outDir = value('--out', join(ROOT, 'docs'));

const store = new FileStore(dataDir);
const [queue, series, events, runs] = await Promise.all([
  store.queue(), store.series(), store.readEvents(), store.readRuns(),
]);
const seed = JSON.parse(await readFile(join(ROOT, 'seed', 'companies.json'), 'utf8'));
const companies = seed.companies.slice().sort((a, b) => a.name.localeCompare(b.name, 'en'));

// "As of" the last run, never "as of now". This is what makes the build
// reproducible; a clock in here would put a diff in every commit.
const lastRun = runs.length ? runs[runs.length - 1] : null;
const asOf = lastRun?.finished_at ?? lastRun?.started_at ?? '1970-01-01T00:00:00Z';

const model = { companies, queue, series, events, runs, asOf };
const stats = indexStats(model);
const health = companyHealth(model);
const changes = recentChanges(events, { limit: 500 });

// Everything data/events.ndjson says was published in error. It is written out
// on purpose and linked from the page: a corrections log that only its author
// can read is a press release. `changes` above already excludes these -- that
// exclusion is what makes the retraction mean anything.
const { retracted } = partitionEvents(events);

// --------------------------------------------------------------------- write

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'api', 'company'), { recursive: true });

const writeJson = (rel, body) => writeFile(join(outDir, rel), `${JSON.stringify(body, null, 1)}\n`, 'utf8');

// GitHub Pages runs Jekyll unless told not to, which would silently drop any
// path beginning with an underscore.
await writeFile(join(outDir, '.nojekyll'), '', 'utf8');

for (const name of ['index.html', 'style.css', 'app.js']) {
  await copyFile(join(ROOT, 'public', name), join(outDir, name));
}

// METHODOLOGY.md lives at the repository root because that is where a reader on
// GitHub looks for it. Served as .txt because browsers render .txt inline and
// download .md.
await copyFile(join(ROOT, 'METHODOLOGY.md'), join(outDir, 'methodology.txt'));

// The corrections log ships with the site, not just with the repository. An
// index whose failures are only visible to people who clone it is not being
// honest, it is being quiet.
await copyFile(join(ROOT, 'CORRECTIONS.md'), join(outDir, 'corrections.txt'));

await writeFile(join(outDir, 'crawler.txt'), crawlerDisclosure(), 'utf8');
await writeFile(join(outDir, 'robots.txt'), 'User-agent: *\nAllow: /\n', 'utf8');

await writeJson('api/stats.json', {
  ...stats,
  categories: categoryDistribution({ series }),
  signals: SIGNALS,
  generated_at: asOf,
});

await writeJson('api/companies.json', { companies });
await writeJson('api/health.json', { companies: health });
await writeJson('api/changes.json', { changes });
await writeJson('api/retractions.json', {
  retracted: retracted
    .slice()
    .sort((a, b) => b.detected_at.localeCompare(a.detected_at) || a.slug.localeCompare(b.slug) || a.signal.localeCompare(b.signal)),
});

for (const company of companies) {
  const detail = companyDetail({
    company,
    queue,
    records: series.get(company.slug) ?? [],
    events,
    runs,
  });
  await writeJson(`api/company/${company.slug}.json`, {
    company: detail.company,
    signals: detail.signals,
    events: detail.events,
    // Reshaped into the fetch-attempt rows the page renders. The ledger stores
    // one compact result per target; the page wants it spelled out.
    fetches: detail.fetches.map((r) => {
      const [found, expected] = String(r.yield ?? '').split('/');
      return {
        kind: r.kind,
        url: r.url,
        fetched_at: r.at,
        http_status: r.http ?? null,
        status: r.status,
        reason: r.reason ?? null,
        bytes: r.bytes ?? 0,
        duration_ms: r.duration_ms ?? 0,
        signals_found: Number(found) || 0,
        signals_expected: Number(expected) || 0,
      };
    }),
  });
}

console.log(
  `built ${outDir}\n` +
  `  ${companies.length} companies, ${stats.observations} observation line(s), ` +
  `${stats.changes} published change event(s), ${retracted.length} retracted, ${runs.length} run(s)\n` +
  `  as of ${asOf}${lastRun ? '' : '  (no crawl has been run yet)'}`
);

// ---------------------------------------------------------------------------

/**
 * The crawler disclosure, served at /crawler.txt.
 *
 * The User-Agent points at CONTACT_URL, which is the README's crawling-policy
 * anchor, so a site operator who greps their logs lands somewhere that answers
 * the question. This file is the same text in a form a script can read.
 */
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
  At most one request per page per day. Requests are strictly serial, and two
  requests to the same host are separated by at least 60 seconds, or by the
  host's Crawl-delay where that is longer. robots.txt is fetched at most once
  per host per run.

  The crawler is not always-on. It runs when a person or a manually triggered
  workflow asks it to, and then the process exits.

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
  Or open an issue at ${CONTACT_URL} and the domain will be removed from the
  seed list entirely.

Not collected
  No personal data. No authenticated pages. No form submissions. No pages
  outside the two URLs published per company in seed/companies.json.
`;
}
