/**
 * Cross-sectional read models: what the 60 companies say *right now*.
 *
 * src/report.js answers "what moved". This file answers "what does the whole
 * set look like today" -- the breadth axis rather than the time axis. Both read
 * the same append-only files and neither touches the network, the clock or the
 * disk, so the site build stays deterministic.
 *
 * THE RULES THIS FILE IS BUILT AROUND
 * -----------------------------------
 * They are the same asymmetry the diff engine uses, applied to counting instead
 * of to change detection.
 *
 *   1. A null is "not readable", never zero and never absent. Every function
 *      here returns an explicit coverage block -- how many companies the number
 *      is computed over, and how many were unreadable -- and the site prints it
 *      next to the chart. `pricing_free_tier` is readable for 32 of 60
 *      companies; the other 28 are not companies without a free tier, they are
 *      companies whose pricing page we could not read.
 *
 *   2. Nothing is imputed. No averages over missing values, no "assume no",
 *      no filling a gap with the mode. A company that is missing from a
 *      denominator is named in the coverage block.
 *
 *   3. The counts are small and the phrasing must match. Seven occurrences of a
 *      word across 59 headlines is a fact about 59 headlines, not a trend. This
 *      file returns raw counts and the denominators; it never returns a
 *      percentage without the n that produced it.
 *
 *   4. Every derived grouping is inspectable. Each bucket carries the companies
 *      in it and the exact string that put them there, so a reader who thinks
 *      the grouping is wrong can check rather than take our word for it.
 *
 * All output is sorted (count descending, then key ascending) so `npm run build`
 * twice produces identical bytes.
 */

import { currentSignals } from './report.js';

// ---------------------------------------------------------------- primitives

/**
 * The latest value of one signal for one company, or null.
 *
 * `last_good_value` is the last value that actually extracted. If extraction is
 * currently failing, that value is still the last thing we know to be true, and
 * the signal carries `suspect` to say the current reading disagrees. Counting
 * the last known-good value is the same choice the diff engine makes and for
 * the same reason: a broken selector is not a company that stopped saying
 * something.
 */
export function signalValue(signals, name) {
  return signals?.[name]?.last_good_value ?? null;
}

/**
 * How much weight the value in `signalValue` can carry right now.
 *
 * Returns null when there is no value at all, and otherwise one of:
 *
 *   fresh    the most recent reading of this page produced this value
 *   held     the most recent reading produced nothing, so this is the last
 *            value we saw. Under the project's own rule that is a parser fault,
 *            not a removal -- but a chart counting it should say so
 *   suspect  the null has repeated often enough that the signal is flagged and
 *            change detection on it is paused
 *
 * The distinction exists because "51 companies publish a category label" and
 * "52, one of which we could not read this morning" are different sentences,
 * and only the second one is true. On 2026-08-07 that second one is Airtable.
 */
export function signalStatus(signals, name) {
  const state = signals?.[name];
  if (!state || state.last_good_value == null) return null;
  if (state.suspect) return 'suspect';
  if ((state.consecutive_nulls ?? 0) > 0) return 'held';
  return 'fresh';
}

/** The structured payload behind a list-valued signal, or null. */
export function signalJson(signals, name) {
  const raw = signals?.[name]?.last_good_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * One row per seeded company, with its latest signal state folded in.
 *
 * Companies with no observations at all are included with empty signals. They
 * are part of every denominator: a company we have never managed to read is a
 * fact about our reach, and dropping it would quietly flatter every chart.
 */
export function latestByCompany({ companies, series }) {
  return companies
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      segment: c.segment,
      signals: currentSignals(series.get(c.slug) ?? []),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/**
 * Lowercase, split on anything that is not a letter or a digit, drop tokens
 * shorter than three characters.
 *
 * No stemming. "agent" and "agents" are counted separately and on purpose: they
 * are different claims. "The system for teams and agents" is a plural noun about
 * a plural thing; "an AI agent for support" is a singular product. Collapsing
 * them would invent a number nobody can check against the headlines listed
 * beside it.
 *
 * The three-character floor is what excludes "ai" -- deliberately. AI language
 * is its own measurement (see aiMentions) rather than one row in a word count
 * where it would dominate and say nothing.
 *
 * An apostrophe is a separator like any other, which is why "you're" becomes
 * "you" and a two-letter tail the floor removes. That pairs with the stopword
 * list below, whose odd-looking entries ("don", "aren", "couldn") are exactly
 * the heads this split produces.
 */
export function tokenize(text) {
  return words(text).filter((t) => t.length >= 3);
}

/**
 * The same split with no length floor.
 *
 * The floor above is a property of the *word count*, where two-letter tokens
 * are noise and "ai" needs its own measurement rather than one dominant row.
 * It is not a property of the language. Applying it to the category vocabulary
 * silently deleted "os" from that vocabulary, so `asana`'s "OS for human-agent
 * teams" was filed under "agent" -- a wrong answer that looked entirely
 * plausible in the chart. Hence two functions with two jobs.
 */
export function words(text) {
  if (text == null) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && /^[a-z]/.test(t));
}

/**
 * The NLTK English stopword list, minus the fragments the tokeniser above can
 * never produce (contraction tails, single letters), plus nothing.
 *
 * Using a published list rather than a hand-rolled one is the point: a stopword
 * list assembled by hand while looking at the results is a way of choosing the
 * answer. If a word below turns out to be interesting, the fix is to say so out
 * loud and change the list, not to quietly special-case it.
 */
export const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'ain', 'all', 'and', 'any', 'are',
  'aren', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'can',
  'couldn', 'did', 'didn', 'doesn', 'doing', 'don', 'down', 'during', 'each',
  'few', 'for', 'from', 'further', 'had', 'hadn', 'has', 'hasn', 'have', 'haven',
  'having', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
  'into', 'isn', 'its', 'itself', 'just', 'mightn', 'more', 'most', 'mustn',
  'myself', 'needn', 'nor', 'not', 'now', 'off', 'once', 'only', 'other', 'our',
  'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shan', 'she', 'should',
  'shouldn', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'too', 'under', 'until', 'very', 'was', 'wasn', 'were', 'weren', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'won',
  'wouldn', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

// ------------------------------------------------------------ headline words

/**
 * The most frequent meaningful words across current hero headlines.
 *
 * Counted once per company, not once per occurrence: a headline that says
 * "teams and teams" contributes one to `teams`. The unit of this index is the
 * company, and a company that repeats itself has not doubled its opinion.
 */
export function headlineWords({ companies, series, limit = 12, field = 'headline' }) {
  const rows = latestByCompany({ companies, series });
  const counts = new Map();
  const missing = [];
  const freshness = tally();

  for (const row of rows) {
    const value = signalValue(row.signals, field);
    if (!value) {
      missing.push({ slug: row.slug, name: row.name });
      continue;
    }
    freshness.add(signalStatus(row.signals, field));
    for (const word of new Set(tokenize(value))) {
      if (STOPWORDS.has(word)) continue;
      if (!counts.has(word)) counts.set(word, []);
      counts.get(word).push({ slug: row.slug, name: row.name, text: value });
    }
  }

  const words = [...counts.entries()]
    .map(([word, examples]) => ({ word, n: examples.length, companies: sortByName(examples) }))
    .sort((a, b) => b.n - a.n || a.word.localeCompare(b.word, 'en'))
    .slice(0, limit);

  return {
    words,
    coverage: coverage(rows.length, rows.length - missing.length, missing, freshness.counts),
    distinct_words: counts.size,
  };
}

// ---------------------------------------------------------- category nouns

/**
 * The noun vocabulary the category label is grouped by.
 *
 * A token -> group map, scanned across the label left to right, first hit wins.
 * Left to right because English puts the head noun of a marketing category
 * before its qualifiers: "AI platform for marketers" is a platform, and
 * "CRM for agentic revenue" is a CRM. Reading right to left would call the
 * first one "marketers".
 *
 * Singular and plural map to the same group here, unlike the headline word
 * count, because "agents" and "agent" as a self-description are the same claim
 * about what the product *is*.
 *
 * The vocabulary is fixed and listed in full so the grouping is auditable, and
 * every group on the site opens to show the exact labels inside it. A label
 * with no token in this list is not forced into a bucket -- it is reported as
 * unmatched and shown verbatim.
 */
export const CATEGORY_NOUNS = new Map(Object.entries({
  platform: 'platform', platforms: 'platform',
  system: 'system', systems: 'system',
  os: 'os',
  infrastructure: 'infrastructure',
  crm: 'crm',
  software: 'software',
  workspace: 'workspace', workspaces: 'workspace',
  agent: 'agent', agents: 'agent',
  tool: 'tool', tools: 'tool', toolkit: 'tool',
  layer: 'layer', layers: 'layer',
  app: 'app', apps: 'app', application: 'app', applications: 'app',
  cloud: 'cloud',
  canvas: 'canvas',
  network: 'network', networks: 'network',
  service: 'service', services: 'service',
  helpdesk: 'helpdesk',
  runtime: 'runtime',
  database: 'database', databases: 'database',
  suite: 'suite',
  engine: 'engine',
  hub: 'hub',
  workflow: 'workflow', workflows: 'workflow',
  assistant: 'assistant', assistants: 'assistant',
  copilot: 'copilot', copilots: 'copilot',
  api: 'api', apis: 'api',
  marketplace: 'marketplace',
  standard: 'standard',
  stack: 'stack',
  model: 'model', models: 'model',
  cdp: 'cdp',
  solution: 'solution', solutions: 'solution',
}));

/** The noun a single category label claims, or null if the vocabulary misses it. */
export function categoryNounOf(label) {
  for (const token of words(label)) {
    const noun = CATEGORY_NOUNS.get(token);
    if (noun) return noun;
  }
  return null;
}

/**
 * How companies describe themselves, grouped by the noun they claim.
 *
 * @returns groups sorted by size, plus the labels the vocabulary did not match,
 *   plus the coverage block naming every company whose category label is not
 *   currently readable.
 */
export function categoryNouns({ companies, series }) {
  const rows = latestByCompany({ companies, series });
  const groups = new Map();
  const unmatched = [];
  const missing = [];
  const freshness = tally();

  for (const row of rows) {
    const label = signalValue(row.signals, 'category_label');
    if (!label) {
      missing.push({ slug: row.slug, name: row.name });
      continue;
    }
    freshness.add(signalStatus(row.signals, 'category_label'));
    const entry = { slug: row.slug, name: row.name, text: label };
    const noun = categoryNounOf(label);
    if (!noun) {
      unmatched.push(entry);
      continue;
    }
    if (!groups.has(noun)) groups.set(noun, []);
    groups.get(noun).push(entry);
  }

  return {
    groups: [...groups.entries()]
      .map(([noun, members]) => ({ noun, n: members.length, companies: sortByName(members) }))
      .sort((a, b) => b.n - a.n || a.noun.localeCompare(b.noun, 'en')),
    unmatched: sortByName(unmatched),
    coverage: coverage(rows.length, rows.length - missing.length, missing, freshness.counts),
  };
}

// -------------------------------------------------------------- AI language

/**
 * The four term families counted as AI language, and the tokens that match them.
 *
 * Matched as whole tokens, so "ai-powered" counts (the tokeniser splits on the
 * hyphen) and "said" does not. "agentic" is listed with "agent" because it is
 * the adjective of the same claim. Nothing here is stemmed or fuzzy-matched:
 * the list is the definition.
 */
export const AI_TERMS = new Map(Object.entries({
  ai: 'ai',
  agent: 'agent', agents: 'agent', agentic: 'agent',
  copilot: 'copilot', copilots: 'copilot',
  autonomous: 'autonomous', autonomy: 'autonomous',
}));

/** The AI/agent term families present in one string, sorted and de-duplicated. */
export function aiTermsIn(text) {
  const found = new Set();
  // The unfloored split, because "ai" is two characters and is the whole point.
  for (const token of words(text)) {
    const family = AI_TERMS.get(token);
    if (family) found.add(family);
  }
  return [...found].sort();
}

const AI_FIELDS = ['headline', 'subhead', 'category_label'];

/**
 * How many companies put AI, agent, copilot or autonomous language in the three
 * places a visitor reads first.
 *
 * The denominator is companies for which at least one of the three fields is
 * readable. A company we cannot read is neither a mention nor a non-mention,
 * and is reported as its own third number rather than folded into either.
 */
export function aiMentions({ companies, series }) {
  const rows = latestByCompany({ companies, series });
  const mentions = [];
  const quiet = [];
  const missing = [];
  const byField = new Map(AI_FIELDS.map((f) => [f, []]));
  const byTerm = new Map();
  const freshness = tally();

  for (const row of rows) {
    const values = AI_FIELDS.map((f) => [f, signalValue(row.signals, f)]);
    if (values.every(([, v]) => !v)) {
      missing.push({ slug: row.slug, name: row.name });
      continue;
    }
    freshness.add(...AI_FIELDS.map((f) => signalStatus(row.signals, f)));

    const terms = new Set();
    const fields = [];
    for (const [field, value] of values) {
      const hits = aiTermsIn(value);
      if (!hits.length) continue;
      fields.push(field);
      byField.get(field).push({ slug: row.slug, name: row.name, text: value });
      for (const t of hits) terms.add(t);
    }

    if (terms.size === 0) {
      quiet.push({ slug: row.slug, name: row.name, text: values.find(([, v]) => v)?.[1] ?? null });
      continue;
    }

    const entry = {
      slug: row.slug,
      name: row.name,
      terms: [...terms].sort(),
      fields,
      text: values.find(([, v]) => v)?.[1] ?? null,
    };
    mentions.push(entry);
    for (const t of entry.terms) {
      if (!byTerm.has(t)) byTerm.set(t, []);
      byTerm.get(t).push(entry);
    }
  }

  return {
    mentions: sortByName(mentions),
    quiet: sortByName(quiet),
    by_field: AI_FIELDS.map((field) => ({
      field,
      n: byField.get(field).length,
      companies: sortByName(byField.get(field)),
    })),
    by_term: [...byTerm.entries()]
      .map(([term, members]) => ({ term, n: members.length, companies: sortByName(members) }))
      .sort((a, b) => b.n - a.n || a.term.localeCompare(b.term, 'en')),
    coverage: coverage(rows.length, rows.length - missing.length, missing, freshness.counts),
  };
}

// ----------------------------------------------------------- pricing shape

/**
 * Ordered price buckets. Ordered, so the chart's x position carries the order
 * and the bars do not need a colour ramp to say the same thing twice.
 *
 * The first bucket exists because it is real: `metabase`, `mongodb`, `supabase`
 * and `intercom` publish usage rates, and the cheapest published number on a
 * usage-priced pricing page is a per-unit rate, not a seat price. Bucketing it
 * with seat prices without saying so would be the dishonest option; dropping it
 * would be the other one.
 */
export const PRICE_BUCKETS = [
  { key: 'under-1', label: 'Under 1.00', min: 0, max: 1 },
  { key: '1-9', label: '1.00 to 9.99', min: 1, max: 10 },
  { key: '10-19', label: '10.00 to 19.99', min: 10, max: 20 },
  { key: '20-49', label: '20.00 to 49.99', min: 20, max: 50 },
  { key: '50-99', label: '50.00 to 99.99', min: 50, max: 100 },
  { key: '100-plus', label: '100.00 and up', min: 100, max: Infinity },
];

/**
 * What the readable pricing pages look like.
 *
 * Three separate denominators, kept separate because they are three separate
 * measurements: tiers readable (32), free tier readable (32), entry price
 * readable (23). `pricing_free_tier: "no"` is a value -- a page we read that
 * publishes no zero-cost plan -- and is counted as such. A page we could not
 * read contributes to none of the three.
 *
 * Amounts are NOT currency-converted. One of the readable entry prices is in
 * EUR and the rest are in USD; converting would require a rate this project
 * does not have and would put a number in the archive that no page ever
 * published. The currency mix is returned so the site can say so.
 */
export function pricingShape({ companies, series }) {
  const rows = latestByCompany({ companies, series });
  const free = [];
  const paidOnly = [];
  const freeMissing = [];
  const tiersReadable = [];
  const entries = [];
  const entryMissing = [];
  const contactSales = [];
  const freeFresh = tally();
  const tierFresh = tally();
  const entryFresh = tally();

  for (const row of rows) {
    const name = { slug: row.slug, name: row.name };

    const freeValue = signalValue(row.signals, 'pricing_free_tier');
    if (freeValue === 'yes' || freeValue === 'no') {
      (freeValue === 'yes' ? free : paidOnly).push(name);
      freeFresh.add(signalStatus(row.signals, 'pricing_free_tier'));
    } else {
      freeMissing.push(name);
    }

    const tiers = signalJson(row.signals, 'pricing_tiers');
    if (tiers?.tiers?.length) {
      tiersReadable.push({ ...name, text: signalValue(row.signals, 'pricing_tiers') });
      tierFresh.add(signalStatus(row.signals, 'pricing_tiers'));
      const hidden = tiers.tiers.filter((t) => t.source === 'contact-sales' || t.amount == null);
      if (hidden.length) {
        contactSales.push({ ...name, text: hidden.map((t) => t.name).sort().join(', ') });
      }
    }

    const entry = signalJson(row.signals, 'pricing_entry_price');
    if (entry && typeof entry.amount === 'number') {
      entryFresh.add(signalStatus(row.signals, 'pricing_entry_price'));
      entries.push({
        ...name,
        amount: entry.amount,
        currency: entry.currency ?? null,
        tier: entry.tier ?? null,
        text: signalValue(row.signals, 'pricing_entry_price'),
      });
    } else {
      entryMissing.push(name);
    }
  }

  const buckets = PRICE_BUCKETS.map((b) => {
    const members = entries.filter((e) => e.amount >= b.min && e.amount < b.max);
    return {
      key: b.key,
      label: b.label,
      n: members.length,
      companies: members.slice().sort((a, b2) => a.amount - b2.amount || a.name.localeCompare(b2.name, 'en')),
    };
  });

  const currencies = new Map();
  for (const e of entries) currencies.set(e.currency ?? 'unknown', (currencies.get(e.currency ?? 'unknown') ?? 0) + 1);

  const amounts = entries.map((e) => e.amount).sort((a, b) => a - b);

  return {
    free_tier: {
      yes: sortByName(free),
      no: sortByName(paidOnly),
      coverage: coverage(rows.length, free.length + paidOnly.length, sortByName(freeMissing), freeFresh.counts),
    },
    tiers: {
      companies: sortByName(tiersReadable),
      contact_sales: sortByName(contactSales),
      coverage: coverage(rows.length, tiersReadable.length, null, tierFresh.counts),
    },
    entry_price: {
      buckets,
      companies: entries.slice().sort((a, b) => a.amount - b.amount || a.name.localeCompare(b.name, 'en')),
      currencies: [...currencies.entries()]
        .map(([currency, n]) => ({ currency, n }))
        .sort((a, b) => b.n - a.n || a.currency.localeCompare(b.currency, 'en')),
      // The median of a set this small is a description of these 23 numbers and
      // nothing more. It is returned because it is cheap and labelled on the
      // site with its n, never as "the market price".
      median: amounts.length ? amounts[(amounts.length - 1) >> 1] : null,
      coverage: coverage(rows.length, entries.length, sortByName(entryMissing), entryFresh.counts),
    },
  };
}

// ------------------------------------------------------------- proof points

/**
 * The extractor's claim kinds, in plain English, and merged where the
 * distinction is ours rather than the market's.
 *
 * `percent` and `percent-trailing` are the same claim written two ways
 * ("40% faster" and "faster by 40%"); splitting them on the site would report a
 * property of our regexes as a property of B2B marketing.
 */
export const CLAIM_KINDS = new Map(Object.entries({
  count: { key: 'count', label: 'Scale counts', note: 'customers, users, records, teams' },
  percent: { key: 'percent', label: 'Percentage gains', note: '"40% faster", "cut costs by 30%"' },
  'percent-trailing': { key: 'percent', label: 'Percentage gains', note: '"40% faster", "cut costs by 30%"' },
  money: { key: 'money', label: 'Money amounts', note: '"$2.4M saved", "$1B processed"' },
  multiplier: { key: 'multiplier', label: 'Multipliers', note: '"10x faster"' },
  rank: { key: 'rank', label: 'Rankings and lists', note: '"Fortune 500", "G2 leader"' },
  time: { key: 'time', label: 'Time to result', note: '"in under 5 minutes"' },
}));

/**
 * What kind of quantified claim companies reach for.
 *
 * Reported per company rather than per claim: a homepage with eleven percentage
 * claims has one opinion about how to prove things, and counting the claims
 * would let one verbose page outvote ten others. The raw claim counts are
 * returned alongside for anyone who wants them.
 */
export function proofClaims({ companies, series }) {
  const rows = latestByCompany({ companies, series });
  const kinds = new Map();
  const missing = [];
  const freshness = tally();
  let readable = 0;
  let totalClaims = 0;

  for (const row of rows) {
    const proof = signalJson(row.signals, 'proof_points');
    if (!proof?.items?.length) {
      missing.push({ slug: row.slug, name: row.name });
      continue;
    }
    readable++;
    freshness.add(signalStatus(row.signals, 'proof_points'));
    totalClaims += proof.items.length;

    const seen = new Map();
    for (const item of proof.items) {
      const kind = CLAIM_KINDS.get(item.kind);
      if (!kind) continue;
      if (!seen.has(kind.key)) seen.set(kind.key, []);
      seen.get(kind.key).push(item.claim);
    }
    for (const [key, claims] of seen) {
      if (!kinds.has(key)) kinds.set(key, { claims: 0, companies: [] });
      const bucket = kinds.get(key);
      bucket.claims += claims.length;
      bucket.companies.push({
        slug: row.slug,
        name: row.name,
        text: claims.slice().sort().join(' · '),
      });
    }
  }

  const labels = new Map([...CLAIM_KINDS.values()].map((k) => [k.key, k]));

  return {
    kinds: [...kinds.entries()]
      .map(([key, bucket]) => ({
        key,
        label: labels.get(key).label,
        note: labels.get(key).note,
        n: bucket.companies.length,
        claims: bucket.claims,
        companies: sortByName(bucket.companies),
      }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'en')),
    total_claims: totalClaims,
    coverage: coverage(rows.length, readable, sortByName(missing), freshness.counts),
  };
}

// ------------------------------------------------------------ customer logos

/**
 * Which customers everyone cites.
 *
 * Counted per company citing, not per appearance, and case-folded before
 * counting because homepages spell the same company `OpenAI`, `Openai` and
 * `openai` depending on whose `alt` text won. The display spelling is the most
 * common original, ties broken alphabetically, so the choice is deterministic
 * rather than whichever file was read first.
 *
 * This is the shallowest measurement on the page and it is labelled that way on
 * the site: logo walls are read from `alt` text, image filenames and inline SVG
 * titles, and a wall built from CSS sprites reads as no logos at all. The
 * numbers below are a floor, never a count of who is actually cited.
 */
export function logoMentions({ companies, series, limit = 12 }) {
  const rows = latestByCompany({ companies, series });
  const byKey = new Map();
  const missing = [];
  const freshness = tally();
  let readable = 0;

  for (const row of rows) {
    const logos = signalJson(row.signals, 'customer_logos');
    if (!logos?.names?.length) {
      missing.push({ slug: row.slug, name: row.name });
      continue;
    }
    readable++;
    freshness.add(signalStatus(row.signals, 'customer_logos'));

    const seen = new Set();
    for (const raw of logos.names) {
      const key = String(raw).toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!byKey.has(key)) byKey.set(key, { spellings: new Map(), companies: [] });
      const bucket = byKey.get(key);
      bucket.spellings.set(raw, (bucket.spellings.get(raw) ?? 0) + 1);
      bucket.companies.push({ slug: row.slug, name: row.name, text: raw });
    }
  }

  const logos = [...byKey.entries()]
    .map(([key, bucket]) => ({
      key,
      logo: [...bucket.spellings.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))[0][0],
      n: bucket.companies.length,
      companies: sortByName(bucket.companies),
    }))
    .sort((a, b) => b.n - a.n || a.logo.localeCompare(b.logo, 'en'));

  return {
    logos: logos.slice(0, limit),
    distinct_logos: logos.length,
    coverage: coverage(rows.length, readable, sortByName(missing), freshness.counts),
  };
}

// --------------------------------------------------------- segment breakdown

/**
 * The five buckets the seed's fourteen `segment` values are folded into.
 *
 * WHY THE SEED SEGMENTS ARE NOT USED DIRECTLY
 * -------------------------------------------
 * seed/companies.json labels each company with one of fourteen segments, and
 * seven of them hold three companies or fewer -- `security` holds exactly one.
 * A bar chart with a cell of n=1 invites the reader to conclude something about
 * "security companies" from Vanta's homepage, which is the precise false
 * precision the rest of this file exists to refuse. Fourteen segments over
 * sixty companies is a taxonomy for a directory, not a denominator.
 *
 * So the segments are folded into five groups of 7 to 16. That fold is a
 * judgement, and it is therefore written down here in full, printed on the site
 * as a table, and constrained by one rule that keeps it honest:
 *
 *   A seed segment is never split. Every company carrying `segment: "design"`
 *   is in the same group as every other one. The mapping is thirteen-plus-one
 *   whole segments moved into five boxes, so the only way to disagree with it
 *   is to disagree with a box -- not to discover that we quietly put Figma in
 *   one place and Miro in another to make a number come out.
 *
 * The rationale for each fold is authored prose (`why`), because it is an
 * opinion about which markets cohere and pretending otherwise would be worse
 * than owning it. The counts beside it are computed.
 */
export const SEGMENT_GROUPS = [
  {
    key: 'dev',
    label: 'Developer & infrastructure',
    short: 'Dev & infrastructure',
    segments: ['dev-infra', 'observability', 'security'],
    why:
      'Sold to the engineering organisation and bought on the same budget: hosting and delivery, ' +
      'the tools that watch it in production, and the compliance automation that reports on it. ' +
      'Observability is two companies on its own and security is one, which is why neither is a bar.',
  },
  {
    key: 'data',
    label: 'Data & analytics',
    short: 'Data & analytics',
    segments: ['analytics', 'data'],
    why:
      'Warehouses, pipelines and the products that read them. The seed splits the store from the ' +
      'question asked of it; the buyer and the pitch are the same, so the two are one bucket here.',
  },
  {
    key: 'work',
    label: 'Work & product',
    short: 'Work & product',
    segments: ['automation', 'design', 'product-dev', 'work-mgmt'],
    why:
      'How a company builds things and runs itself day to day: issue trackers, docs, whiteboards, ' +
      'chat, and the glue between them. The biggest bucket at 16, and the most internally varied &mdash; ' +
      'it is the one to be most sceptical of.',
  },
  {
    key: 'gtm',
    label: 'Go-to-market & support',
    short: 'Go-to-market',
    segments: ['gtm', 'marketing', 'support'],
    why:
      'Everything pointed at a customer: finding them, marketing to them, selling to them, and ' +
      'answering them afterwards. Support sits here rather than with work management because a ' +
      'helpdesk is sold to the revenue side of the house.',
  },
  {
    key: 'ops',
    label: 'Finance & people ops',
    short: 'Finance & people',
    segments: ['fintech-ops', 'hr-ops'],
    why:
      'The back office: money in and out, and payroll, hiring and reviews. At 7 companies this is ' +
      'the smallest group and the one where a single homepage moves a bar furthest.',
  },
];

/**
 * The smallest denominator that gets a mark drawn.
 *
 * At six companies one of them is 17 percentage points, which is already wider
 * than most of the differences this page reports. At four it is 25 points, and
 * a bar that one homepage edit moves a quarter of its length is a decoration.
 * A cell below the floor is not rounded, not pooled and not quietly omitted --
 * it is drawn as the words "too few to say" with its own n beside it.
 */
export const MIN_CELL_N = 6;

/**
 * How many of the five groups must clear the floor before a cut is drawn at all.
 *
 * A comparison across two or three groups of a sixty-company set is not a
 * segment breakdown, it is two or three numbers with a chart around them.
 */
export const MIN_GROUPS_DRAWN = 4;

/**
 * The number of companies whose answer, if flipped, makes a spread meaningless.
 *
 * A cut whose extremes are this close is withheld rather than drawn with a
 * caveat, because a reader looks at the bars and not at the caveat.
 */
export const FRAGILE_FLIPS = 2;

const SEGMENT_TO_GROUP = new Map(
  SEGMENT_GROUPS.flatMap((g) => g.segments.map((s) => [s, g.key]))
);

/** The group key a seed segment folds into, or null if the mapping misses it. */
export function groupOfSegment(segment) {
  return SEGMENT_TO_GROUP.get(segment) ?? null;
}

/**
 * How many companies in `low` would have to change their answer for its share
 * to reach `high`'s. The width of a difference, in companies.
 *
 * This is the number the copy on the site is required to print next to any
 * comparison of two groups, because with cells of 7 to 16 it is usually one or
 * two, and "go-to-market leads finance by 50 points" and "three companies
 * separate them" are the same fact told honestly and dishonestly.
 *
 * Solved in integers -- the smallest k with
 * `(low.yes + k) * high.readable >= high.yes * low.readable` -- so the answer
 * is exact and the build stays byte-stable. Returns 0 when `low` already
 * matches or beats `high`, and null when either cell has no denominator.
 */
export function flipsToTie(high, low) {
  if (!high?.readable || !low?.readable) return null;
  const gap = (high.yes * low.readable) - (low.yes * high.readable);
  if (gap <= 0) return 0;
  return Math.ceil(gap / high.readable);
}

/**
 * The yes/no/unreadable test behind each cut, and what each denominator means.
 *
 * Every `read` returns `true`, `false`, or `null` for "we could not read this",
 * and null is never folded into false. That is the same rule the rest of the
 * file runs on, applied one group at a time, where it bites hardest: a segment
 * cell has a tenth of the set's denominator and so a tenth of its tolerance for
 * a missing value quietly becoming a zero.
 *
 * The list is fixed and every cut in it is computed. Which ones end up drawn is
 * decided by the rules below from the numbers, not chosen here by looking at
 * the answers -- picking the cuts that came out interesting is how a chart
 * starts lying without anybody writing down a false number.
 */
const SEGMENT_CUTS = [
  {
    key: 'ai',
    label: 'Uses AI or agent language',
    // How the cut is named mid-sentence by the copy on the site. Authored
    // rather than derived from `label`, because lower-casing a label to drop it
    // into a sentence turns "AI" into "ai".
    subject: 'AI and agent language',
    denominator: 'companies whose headline, subhead or category label we can read',
    read: (signals) => {
      const values = AI_FIELDS.map((f) => signalValue(signals, f));
      if (values.every((v) => !v)) return null;
      return values.some((v) => aiTermsIn(v).length > 0);
    },
  },
  {
    key: 'platform',
    label: 'Calls itself a platform',
    subject: 'the word &ldquo;platform&rdquo;',
    denominator: 'companies whose category label we can read',
    read: (signals) => {
      const label = signalValue(signals, 'category_label');
      return label ? categoryNounOf(label) === 'platform' : null;
    },
  },
  ...[...new Map([...CLAIM_KINDS.values()].map((k) => [k.key, k])).values()].map((kind) => ({
    key: `proof-${kind.key}`,
    label: `Proves with ${kind.label.toLowerCase()}`,
    subject: `${kind.label.toLowerCase()} as proof`,
    denominator: 'companies with at least one quantified claim we can read',
    read: (signals) => {
      const proof = signalJson(signals, 'proof_points');
      if (!proof?.items?.length) return null;
      return proof.items.some((item) => CLAIM_KINDS.get(item.kind)?.key === kind.key);
    },
  })),
  {
    key: 'free-tier',
    label: 'Publishes a free tier',
    subject: 'a published free tier',
    denominator: 'companies whose pricing page we can read',
    read: (signals) => {
      const value = signalValue(signals, 'pricing_free_tier');
      if (value !== 'yes' && value !== 'no') return null;
      return value === 'yes';
    },
  },
];

/**
 * Every cut, by group, with the decision about whether it may be drawn.
 *
 * The shape is deliberately verbose. `cells` carries the counts in the fixed
 * group order for the table; `ranked` carries the drawable ones sorted for the
 * chart; `spread` carries the width of the difference in companies; and
 * `withheld` carries a machine-readable reason when the cut is not drawn, so
 * the site can print why rather than silently showing five sections where a
 * previous build showed eight.
 *
 * `share` is only present on a cell that cleared the floor, so a suppressed
 * cell has no percentage for a renderer to reach for by accident.
 */
export function segmentBreakdown({ companies, series }) {
  const rows = latestByCompany({ companies, series });

  const members = new Map(SEGMENT_GROUPS.map((g) => [g.key, []]));
  const ungrouped = [];
  for (const row of rows) {
    const key = groupOfSegment(row.segment);
    if (key) members.get(key).push(row);
    else ungrouped.push({ slug: row.slug, name: row.name, text: row.segment ?? null });
  }

  const groups = SEGMENT_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    short: g.short,
    why: g.why,
    n: members.get(g.key).length,
    segments: g.segments
      .map((s) => ({ segment: s, n: rows.filter((r) => r.segment === s).length }))
      .sort((a, b) => b.n - a.n || a.segment.localeCompare(b.segment, 'en')),
    companies: sortByName(members.get(g.key).map((r) => ({ slug: r.slug, name: r.name, text: r.segment }))),
  }));

  const cuts = SEGMENT_CUTS.map((cut) => {
    const cells = SEGMENT_GROUPS.map((g) => cell(g, members.get(g.key), cut.read));

    const drawable = cells.filter((c) => !c.suppressed);
    const ranked = drawable
      .slice()
      .sort((a, b) => (b.yes * a.readable) - (a.yes * b.readable) || a.label.localeCompare(b.label, 'en'));

    const top = ranked[0] ?? null;
    const bottom = ranked.length > 1 ? ranked[ranked.length - 1] : null;
    const runnerUp = ranked.length > 1 ? ranked[1] : null;
    const spread = bottom ? flipsToTie(top, bottom) : null;

    // First matching rule wins, so the reason a cut is missing is stable across
    // builds rather than depending on which check happened to run first.
    let withheld = null;
    if (drawable.length < MIN_GROUPS_DRAWN) {
      withheld = { rule: 'coverage', drawable: drawable.length, groups: cells.length };
    } else if (spread != null && spread <= FRAGILE_FLIPS) {
      withheld = { rule: 'flat', spread };
    }

    const totals = cells.reduce(
      (acc, c) => ({
        yes: acc.yes + c.yes,
        no: acc.no + c.no,
        unreadable: acc.unreadable + c.unreadable,
      }),
      { yes: 0, no: 0, unreadable: 0 }
    );

    return {
      key: cut.key,
      label: cut.label,
      subject: cut.subject,
      denominator: cut.denominator,
      cells,
      ranked,
      top,
      runner_up: runnerUp,
      bottom,
      spread,
      // How many companies would tie the first two, which is the number that
      // decides whether the *order* of the bars means anything at all.
      lead_over_runner_up: runnerUp ? flipsToTie(top, runnerUp) : null,
      drawn: withheld === null,
      withheld,
      overall: {
        ...totals,
        readable: totals.yes + totals.no,
        tracked: rows.length,
      },
    };
  });

  return {
    groups,
    cuts,
    drawn: cuts.filter((c) => c.drawn).map((c) => c.key),
    withheld: cuts.filter((c) => !c.drawn).map((c) => c.key),
    min_cell_n: MIN_CELL_N,
    min_groups_drawn: MIN_GROUPS_DRAWN,
    fragile_flips: FRAGILE_FLIPS,
    // Never expected to be non-empty: every seed segment is mapped above. It is
    // returned anyway, because the way this breaks is somebody adding a
    // fifteenth segment to the seed and no chart ever mentioning those
    // companies again.
    ungrouped: sortByName(ungrouped),
    coverage: coverage(rows.length, rows.length - ungrouped.length, ungrouped, null),
  };
}

/** One group's answer to one cut. Nulls are their own count, never a `no`. */
function cell(group, rows, read) {
  const yes = [];
  const no = [];
  const unreadable = [];

  for (const row of rows) {
    const entry = { slug: row.slug, name: row.name };
    const value = read(row.signals);
    if (value === null) unreadable.push(entry);
    else if (value) yes.push(entry);
    else no.push(entry);
  }

  const readable = yes.length + no.length;
  const suppressed = readable < MIN_CELL_N;

  return {
    group: group.key,
    label: group.label,
    short: group.short,
    n: rows.length,
    readable,
    yes: yes.length,
    no: no.length,
    unreadable: unreadable.length,
    // Absent rather than null-and-present on a suppressed cell: there is no
    // percentage to print, so there is nothing here to print it from.
    ...(suppressed ? {} : { share: Math.round((yes.length / readable) * 1000) / 10 }),
    suppressed,
    companies: {
      yes: sortByName(yes),
      no: sortByName(no),
      unreadable: sortByName(unreadable),
    },
  };
}

// ------------------------------------------------------------------- bundle

/**
 * Everything the landing view shows, in one deterministic object.
 *
 * Written to docs/api/positioning.json so the numbers on the page can be
 * checked against the same file a script would read.
 */
export function stateOfPositioning({ companies, series }) {
  return {
    headline_words: headlineWords({ companies, series }),
    category_nouns: categoryNouns({ companies, series }),
    ai_mentions: aiMentions({ companies, series }),
    proof_claims: proofClaims({ companies, series }),
    logo_mentions: logoMentions({ companies, series }),
    pricing: pricingShape({ companies, series }),
    segments: segmentBreakdown({ companies, series }),
  };
}

// ------------------------------------------------------------------ helpers

/**
 * The coverage block every chart on the site is required to print.
 *
 * `tracked` is always the full seed list. `readable` is what the number was
 * actually computed over. `unreadable` is the difference, and `missing` names
 * the companies in it where naming them is useful. `held` and `suspect` say how
 * many of the readable values are last-known-good rather than read this morning.
 * There is no field for "assumed", because there is no assuming.
 */
function coverage(tracked, readable, missing, flags) {
  return {
    tracked,
    readable,
    unreadable: tracked - readable,
    held: flags?.held ?? 0,
    suspect: flags?.suspect ?? 0,
    missing: missing ?? null,
  };
}

/**
 * Counts companies by how fresh their contributing signals are, taking the
 * worst status across the signals that produced the company's row.
 */
function tally() {
  const counts = { fresh: 0, held: 0, suspect: 0 };
  return {
    counts,
    add(...statuses) {
      const present = statuses.filter(Boolean);
      if (!present.length) return;
      if (present.includes('suspect')) counts.suspect++;
      else if (present.includes('held')) counts.held++;
      else counts.fresh++;
    },
  };
}

function sortByName(entries) {
  return entries.slice().sort((a, b) => a.name.localeCompare(b.name, 'en') || a.slug.localeCompare(b.slug, 'en'));
}
