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
  withConfirmation,
} from '../src/report.js';
import { stateOfPositioning } from '../src/insights.js';
import { pageAnatomy } from '../src/anatomy-insights.js';
import { accuracyBlock, sectionInsight, pageInsight } from '../src/anatomy-compare.js';
import { scoreClassifier } from '../src/anatomy-score.js';
import { neighbourGraph } from '../src/anatomy-similarity.js';
import { layout3d } from '../src/anatomy-layout3d.js';
import { clusterShapes } from '../src/anatomy-clusters.js';
import { renderPositioning } from '../src/landing.js';
import { renderAnatomy } from '../src/anatomy-view.js';
import { MAX_BLOCK_HEIGHT, MIN_BLOCK_HEIGHT, SECTION_LABEL, WIREFRAME_WIDTH } from '../src/anatomy-svg.js';

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
const labels = JSON.parse(await readFile(join(ROOT, 'seed', 'labels.json'), 'utf8'));
const companies = seed.companies.slice().sort((a, b) => a.name.localeCompare(b.name, 'en'));

// "As of" the last run, never "as of now". This is what makes the build
// reproducible; a clock in here would put a diff in every commit.
const lastRun = runs.length ? runs[runs.length - 1] : null;
const asOf = lastRun?.finished_at ?? lastRun?.started_at ?? '1970-01-01T00:00:00Z';

const model = { companies, queue, series, events, runs, asOf };
const stats = indexStats(model);
const health = companyHealth(model);
// Carrying `confirmed` so the page can say which of these have been read again
// since, and which have been seen exactly once. See src/report.js.
const changes = withConfirmation(recentChanges(events, { limit: 500 }), queue);

// Everything data/events.ndjson says was published in error. It is written out
// on purpose and linked from the page: a corrections log that only its author
// can read is a press release. `changes` above already excludes these -- that
// exclusion is what makes the retraction mean anything.
const { retracted } = partitionEvents(events);

// The cross-sectional read: what all 60 companies are saying today, as opposed
// to what moved. It is the landing view, and it is rendered to HTML here rather
// than fetched by the page, so the charts and their numbers exist in the file
// with scripting switched off. See src/charts.js for why the SVG has no viewBox.
const positioning = stateOfPositioning({ companies, series });
const anatomy = pageAnatomy({ companies, series });

// The classifier's accuracy is MEASURED at build time against seed/labels.json,
// never typed into a file. A hardcoded accuracy is a claim that goes stale the
// moment the classifier changes, and this project already has a corrections
// entry about exactly that class of mistake. If there are no labels, the caveat
// says the classifier is unmeasured rather than quietly reporting a stale one.
// scoreClassifier returns the RAW counts, which is what sectionInsight,
// pageInsight and classifierCaveat all take -- they derive their own ratios so
// the sentence cannot disagree with the number beside it. accuracyBlock() turns
// the same counts into the published ratios. Passing the derived block into the
// insight functions is what produced "agreed on null of null non-hero sections"
// on the panel: they went looking for counts and found ratios.
const score = scoreClassifier({ seed, series, labels });

// Which pages are shaped alike, computed here and published, so the claim is
// part of the record rather than something the browser invented on load.
const similarity = neighbourGraph(anatomy.companies, { k: 6 });
// The recurring shape families in the graph, then a deterministic 3D arrangement
// seeded from them so the WebGL cloud renders separated, named lobes rather than
// a formless blob. Both are published so the arrangement is checkable, not
// invented on load. nodeCluster is only needed to build the layout; each node
// carries its own family id, so it is dropped before publishing.
const clusters = clusterShapes(anatomy, similarity);
similarity.layout3d = layout3d(anatomy.companies, similarity, {
  nodeCluster: clusters.nodeCluster,
  clusterCount: clusters.clusters.length,
});
delete clusters.nodeCluster;
similarity.clusters = clusters;
const accuracy = accuracyBlock(score);

// --------------------------------------------------------------------- write

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'api', 'company'), { recursive: true });

const writeJson = (rel, body) => writeFile(join(outDir, rel), `${JSON.stringify(body, null, 1)}\n`, 'utf8');

// GitHub Pages runs Jekyll unless told not to, which would silently drop any
// path beginning with an underscore.
await writeFile(join(outDir, '.nojekyll'), '', 'utf8');

// Vendored third-party code, served from this origin. See public/vendor/README.md
// for why downloading a file once is not the same act as making a visitor's
// browser fetch it from somebody else's server.
await mkdir(join(outDir, 'vendor', 'fonts'), { recursive: true });
for (const name of [
  'd3-dispatch.js', 'd3-quadtree.js', 'd3-timer.js', 'd3-force.js',
  // WebGL point cloud + the motion layer, both vendored and served from here.
  'three.module.min.js', 'gsap.min.js', 'ScrollTrigger.min.js',
]) {
  await copyFile(join(ROOT, 'public', 'vendor', name), join(outDir, 'vendor', name));
}
// Self-hosted fonts. The @font-face file references fonts/*.woff2 relative to
// itself, so it and the binaries land together under docs/vendor/fonts/.
for (const name of ['fonts.css', 'newsreader.woff2', 'newsreader-italic.woff2', 'roboto.woff2']) {
  await copyFile(join(ROOT, 'public', 'vendor', 'fonts', name), join(outDir, 'vendor', 'fonts', name));
}

for (const name of [
  'style.css', 'app.js', 'anatomy-app.js', 'anatomy-map.js', 'archetype-mock.js',
  'anatomy-globe.js', 'motion.js',
]) {
  await copyFile(join(ROOT, 'public', name), join(outDir, name));
}

// index.html is the one file that is generated rather than copied, because the
// landing view is baked into it. Every substitution is a comment marker that
// must be present -- a silently un-substituted template would ship a page with
// a hole in it, and this build is the only thing standing between data/ and
// what the public reads.
await writeFile(join(outDir, 'index.html'), renderIndexHtml(await readFile(join(ROOT, 'public', 'index.html'), 'utf8')), 'utf8');

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

// The same numbers the landing view prints, in the form a script can read, so
// every bar on the page can be checked against the file that produced it.
await writeJson('api/positioning.json', { ...positioning, generated_at: asOf });
// The explorer is a client-side app, so everything it needs to draw and to
// name things is published here rather than duplicated in the browser code.
// One source of truth for the label map and the geometry: add a section type to
// the classifier and the app picks up its label without being touched.
await writeJson('api/anatomy.json', {
  ...anatomy,
  accuracy,
  labels: SECTION_LABEL,
  similarity,
  geometry: { width: WIREFRAME_WIDTH, minBlock: MIN_BLOCK_HEIGHT, maxBlock: MAX_BLOCK_HEIGHT },
  insights: Object.fromEntries(anatomy.companies.map((c) => [c.slug, {
    page: slimPage(pageInsight({ company: c, anatomy, accuracy: score })),
    sections: Object.fromEntries((c.sections ?? []).map((sec) => [
      String(sec.position),
      slimSection(sectionInsight({ section: sec, company: c, anatomy, accuracy: score })),
    ])),
  }])),
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
  `  landing view: ${positioning.headline_words.coverage.readable} headlines, ` +
  `${positioning.category_nouns.coverage.readable} category labels, ` +
  `${positioning.ai_mentions.mentions.length} companies using AI language, ` +
  `${positioning.pricing.entry_price.coverage.readable} readable entry prices\n` +
  `  segments: ${positioning.segments.groups.length} groups, ` +
  `${positioning.segments.drawn.length} of ${positioning.segments.cuts.length} cuts drawn, ` +
  `${positioning.segments.withheld.length} withheld (${positioning.segments.withheld.join(', ')})\n` +
  `  as of ${asOf}${lastRun ? '' : '  (no crawl has been run yet)'}`
);

/**
 * Publish what the panel renders, not the whole derivation.
 *
 * A full section insight is 13kB, and 8kB of that is the ranking of every type
 * at that position with its company list -- corpus-wide data, identical for
 * every company at the same position, and already published once under
 * `positions`. Written out per section it produced a 28MB api/anatomy.json.
 *
 * The caveat and accuracy ARE kept on every section, deliberately. They are
 * byte-identical everywhere so they compress to nothing, and the alternative is
 * a panel that can render a judged claim with no caveat attached if a lookup
 * misses.
 */
function slimSection(i) {
  return {
    position: i.position, type: i.type, typeLabel: i.typeLabel,
    heading: i.heading, words: i.words, readable: i.readable, present: i.present,
    measured: (i.measured ?? []).map((m) => ({
      label: m.label, value: m.value, unit: m.unit, comparison: m.comparison,
    })),
    // `judged[].companies` is dropped: it repeats, per section, the same peer
    // list `peers` already carries once, and the sentence in `value` states the
    // n and the denominator. Keeping both cost 5MB across the corpus.
    judged: (i.judged ?? []).map((j) => ({
      label: j.label, value: j.value, n: j.n, of: j.of, share: j.share,
    })),
    peers: i.peers,
    caveat: i.caveat,
    notes: i.notes?.length ? i.notes : undefined,
  };
}

function slimPage(p) {
  return {
    readable: p.readable, sequenceReadable: p.sequenceReadable, sections: p.sections,
    measured: (p.measured ?? []).map((m) => ({
      key: m.key, label: m.label, value: m.value, unit: m.unit,
      comparison: m.comparison, placement: m.placement?.band ?? null,
      rank: m.rank?.text ?? null,
    })),
    judged: (p.judged ?? []).map((j) => ({
      key: j.key, label: j.label, value: j.value, text: j.text, n: j.n, of: j.of,
    })),
    caveat: p.caveat,
  };
}

// ---------------------------------------------------------------------------

/**
 * Fill the three markers in public/index.html.
 *
 * Throws on a missing marker rather than shipping the page without it. A
 * template hole is invisible in a diff of a generated directory and would put
 * an empty landing view in front of every visitor, which is exactly the class
 * of silent failure the rest of this project refuses to allow.
 */
function renderIndexHtml(template) {
  const substitutions = [
    ['<!--POSITIONING-->', renderPositioning(positioning)],
    ['<!--ANATOMY-->', renderAnatomy(anatomy, score, similarity.clusters)],
    ['<!--COMPANY-COUNT-->', String(companies.length)],
    ['<!--STAT-SECTIONS-->', String(anatomy.quality.sections)],
    ['<!--STAT-READABLE-->', String(anatomy.positions.coverage.readable)],
    // Date only. The page is a reading of one morning and says so; a timestamp
    // to the second would suggest a precision the crawl does not have, since a
    // full sweep is spread over an hour of politeness delays.
    ['<!--AS-OF-->', asOf.slice(0, 10)],
  ];

  let out = template;
  for (const [marker, value] of substitutions) {
    if (!out.includes(marker)) throw new Error(`public/index.html is missing the ${marker} marker`);
    out = out.split(marker).join(value);
  }
  return out;
}

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
