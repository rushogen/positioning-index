/**
 * The diff engine.
 *
 * This is the part of the project that has to be right. Everything else --
 * crawling, storage, the public page -- is plumbing around one question:
 *
 *     Did this company change what it says, or did our parser break?
 *
 * Get that wrong in the optimistic direction and the index publishes fiction:
 * "Notion removed its free plan", "Figma dropped 14 customer logos". Those are
 * the kind of claims a GTM team would act on, and if they are artefacts of a
 * CSS refactor on the other end, the index is worse than useless.
 *
 * The bias here is therefore heavily asymmetric. Missing a real change costs us
 * one day; the next run catches it. Publishing a fake one costs credibility
 * permanently. So every rule below resolves ambiguity towards "say nothing".
 *
 * The rules, in the order they are applied:
 *
 *   PAGE LEVEL (suppresses every signal on the page)
 *   P1  The fetch was not ok           -> no diffs at all.
 *   P2  Locale or final URL changed    -> a German page is not a repositioning.
 *   P3  Content variant changed        -> HTML vs agent-markdown are not comparable.
 *   P4  Extraction yield collapsed     -> the page was redesigned; re-baseline.
 *   P5  Extractor version changed      -> WE changed; re-baseline, emit nothing.
 *   P6  Crawl origin changed           -> WHERE WE STOOD changed, not the page.
 *
 *   SIGNAL LEVEL
 *   S1  No prior state                 -> baseline, no event.
 *   S2  null now, value before         -> PARSER FAULT. Never an event.
 *   S3  Sustained null + healthy page  -> confirmed removal, one event.
 *   S10 value now, null before         -> SIGNAL ACQUISITION. Never an event.
 *   S4  Confidence dropped sharply     -> suspect our method, not their copy.
 *   S8  Origin shifted, price signal   -> CONTEXT FAULT. Never an event.
 *   S9  Currency moved, amounts proportionate -> locale routing. Never an event.
 *   S5  List shrank past the threshold -> suspect our selector, not their logos.
 *   S6  Value equal after canonicalisation -> unchanged.
 *   S7  Otherwise                      -> a real change.
 *
 * S8 and S9 were added on 2026-08-07 after this index published two false change
 * events about Notion's pricing (see CORRECTIONS.md). They are the sibling of
 * S2, not its replacement: S2 says a missing value is our parser breaking, S8
 * and S9 say a moved value can be our vantage point moving. Same asymmetry, same
 * rule -- record the observation, publish nothing, never silently drop it.
 *
 * S10 was added the same day, for the same reason and from the same family. S2
 * had been suspicious of value -> null since the first commit and the engine was
 * not suspicious of null -> value at all, which is an asymmetry with no
 * justification behind it: "our selector finally worked" and "they finally added
 * it" are one transition wearing two hats. The index published
 * `airtable/home customer_logos` as an addition on the strength of that gap. It
 * no longer publishes any of them.
 */

import { fnv1a } from './hash.js';
import { SIGNALS } from './extract/index.js';
import { describeOrigin, originsDiffer } from './crawl/origin.js';

// --------------------------------------------------------------------- knobs

/**
 * Consecutive null runs before we flag the signal as suspect on the public
 * health view. Two is enough to rule out a one-off timeout or a partial render.
 */
export const SUSPECT_AFTER = 2;

/**
 * Consecutive null runs before we are willing to say a value was REMOVED rather
 * than merely missed. Five daily runs is five independent chances for a
 * transient failure to clear. Combined with the requirement that the rest of
 * the page kept extracting normally, this is a high bar on purpose.
 */
export const REMOVAL_CONFIRMATIONS = 5;

/**
 * If a page yields less than this fraction of the signals it yielded before,
 * treat the whole page as restructured and suppress every diff on it. A
 * redesign that moves the hero into a <div role="banner"> would otherwise fire
 * five "changes" at once, which is the signature of our bug, not their strategy.
 */
export const STRUCTURE_YIELD_RATIO = 0.5;

/**
 * List signals only. A logo wall going from 14 names to 3 is our selector
 * missing the wall, not thirteen customers churning in one night.
 */
export const LIST_COLLAPSE_RATIO = 0.4;

/**
 * If the extractor fell back to a materially weaker strategy (h1 -> og:title,
 * confidence 1.0 -> 0.4) AND the value changed, the value change is far more
 * likely to be an artefact of the fallback than a rewrite.
 */
export const CONFIDENCE_DROP = 0.3;

/**
 * How many previous values a signal remembers.
 *
 * A/B-tested heroes rotate between a small set of variants. Without memory,
 * every rotation reads as a repositioning and the feed fills with noise from
 * companies that are simply running an experiment. Six is enough to catch a
 * two- or three-way split test across a few days without pretending we can
 * remember a year.
 */
export const RECENT_MEMORY = 6;

/**
 * The band of after/before ratios that a currency change can plausibly be an
 * exchange-rate artefact rather than a repricing.
 *
 * Notion's EUR 9.5 and USD 10 are the same plan at the same price, quoted in two
 * currencies: a ratio of 1.05. Nobody reprices by 5% and changes currency in the
 * same release; a site that geo-routes does exactly that on every request. A
 * doubling or a halving is out of the band, because no pair of currencies this
 * index will ever see is that far apart at the price points it observes.
 */
export const FX_RATIO_MIN = 0.5;
export const FX_RATIO_MAX = 2.0;

/**
 * How far apart the per-tier ratios may be and still count as one conversion.
 *
 * A currency conversion moves every tier by the same factor, give or take
 * rounding to a marketing-friendly number (9.5 -> 10 is 1.053, 19.5 -> 20 is
 * 1.026). A repricing moves the tiers by different amounts on purpose. 1.35
 * accommodates the rounding on small numbers without accommodating a genuine
 * restructure of the price list.
 */
export const FX_RATIO_SPREAD = 1.35;

/**
 * How many consecutive observations of the same new currency, from the same
 * crawl origin, before the new value is adopted as the baseline.
 *
 * It is adopted SILENTLY. The index will not report a currency-only price change
 * at all, ever, because it cannot tell one from locale routing and the whole
 * project is built on refusing to guess in that direction. Three runs from a
 * stable origin is enough to stop comparing against a value we can no longer
 * observe; it is not enough to make a public claim, and no claim is made.
 */
export const CURRENCY_CONFIRMATIONS = 3;

/**
 * How many consecutive observations of the same newly-appeared value, from a
 * healthy read, before it is adopted as the signal's baseline.
 *
 * Three, deliberately the same number as CURRENCY_CONFIRMATIONS above, because
 * the two rules are answering the same question -- "is this value ours or
 * theirs?" -- with the same evidence, which is repetition. A second reading rules
 * out a one-off render; a third rules out a page that alternates. There is no
 * separate theory here that would justify a separate number.
 *
 * As with the currency rule, adoption is SILENT. The index will not report the
 * moment a company first publishes a logo wall or a proof point, because it
 * cannot tell that moment apart from the moment our extractor first managed to
 * read one.
 */
export const ACQUISITION_CONFIRMATIONS = 3;

// ------------------------------------------------------------------ currency

const CURRENCY_SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };

/**
 * Currency-bearing tokens in a plain value string: `EUR 9.5`, `$12`, `12 €`.
 *
 * Used for signals with no structured JSON behind them -- a proof point reading
 * "$2.4M saved", a headline quoting a price -- so that the currency rule below
 * protects them without every such signal having to be listed in the registry.
 */
const CURRENCY_TOKEN = /\b([A-Z]{3})\s*([\d][\d.,]*)|([$€£¥₹])\s*([\d][\d.,]*)|([\d][\d.,]*)\s*([$€£¥₹])/g;

const toAmount = (s) => {
  const n = Number.parseFloat(String(s).replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/**
 * The currencies a value quotes, and the amounts quoted in them, keyed so that
 * before and after can be lined up.
 *
 * Structured JSON is preferred because it keys by tier name, which survives a
 * reordered pricing table. The text scan keys by position, which does not, and
 * is only reached for signals that have no JSON.
 */
export function currencyProfile(value, json) {
  const parsed = typeof json === 'string' ? safeJson(json) : json;
  const currencies = new Set();
  const amounts = new Map();

  if (parsed && Array.isArray(parsed.tiers)) {
    for (const t of parsed.tiers) {
      if (t?.currency) currencies.add(String(t.currency).toUpperCase());
      if (typeof t?.amount === 'number') amounts.set(String(t.name ?? amounts.size), t.amount);
    }
    if (currencies.size) return { currencies, amounts, source: 'json' };
  }

  if (parsed && (parsed.currency || typeof parsed.amount === 'number')) {
    if (parsed.currency) currencies.add(String(parsed.currency).toUpperCase());
    if (typeof parsed.amount === 'number') amounts.set(String(parsed.tier ?? 'value'), parsed.amount);
    if (currencies.size) return { currencies, amounts, source: 'json' };
  }

  let i = 0;
  for (const m of String(value ?? '').matchAll(CURRENCY_TOKEN)) {
    const code = m[1] ?? CURRENCY_SYMBOLS[m[3]] ?? CURRENCY_SYMBOLS[m[6]];
    const amount = toAmount(m[2] ?? m[4] ?? m[5]);
    if (!code) continue;
    currencies.add(code.toUpperCase());
    if (amount != null) amounts.set(`#${i++}`, amount);
  }
  return { currencies, amounts, source: 'text' };
}

/** Does this value quote a price in some currency at all? */
export function carriesCurrency(value, json) {
  return currencyProfile(value, json).currencies.size > 0;
}

/**
 * Did the currency move, and if so, did the numbers move with it proportionately?
 *
 * A proportionate move is the signature of locale routing: the same price list,
 * converted. A disproportionate one is a repricing that happens to have changed
 * currency too, and that IS news -- so it is not suppressed.
 *
 * @returns {null|{from: string, to: string, proportionate: boolean, min: number|null, max: number|null}}
 */
export function currencyShift(before, after) {
  const A = currencyProfile(before?.value, before?.json);
  const B = currencyProfile(after?.value, after?.json);
  if (!A.currencies.size || !B.currencies.size) return null;

  const from = [...A.currencies].sort().join(',');
  const to = [...B.currencies].sort().join(',');
  if (from === to) return null;

  const ratios = [];
  let comparable = true;
  for (const [key, a] of A.amounts) {
    const b = B.amounts.get(key);
    if (typeof b !== 'number') continue;
    if (a === 0 && b === 0) continue;          // free stays free; carries no rate
    if (a === 0 || b === 0) { comparable = false; break; }
    ratios.push(b / a);
  }

  if (!comparable || !ratios.length) return { from, to, proportionate: false, min: null, max: null };

  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  const proportionate = min >= FX_RATIO_MIN && max <= FX_RATIO_MAX && max / min <= FX_RATIO_SPREAD;
  return { from, to, proportionate, min, max };
}

/**
 * Is this signal one whose value the crawl origin can decide?
 *
 * Two ways to qualify: it is flagged `localeSensitive` in the signal registry
 * (every published price is), or the value it holds -- before or after -- quotes
 * a currency, whatever signal it happens to be.
 */
export function localeSensitive(signal, before, after) {
  if (SIGNALS[signal]?.localeSensitive) return true;
  return carriesCurrency(before?.value, before?.json) || carriesCurrency(after?.value, after?.json);
}

// ---------------------------------------------------------------- comparison

/**
 * Canonical form for equality testing.
 *
 * Typography churn is not positioning. Smart quotes, en dashes, non-breaking
 * spaces and hyphen variants flip constantly as CMS content is re-saved, and
 * none of it means anything. Case is NOT normalised: "the AI workspace" and
 * "The AI Workspace" are a real editorial decision.
 */
export function canonical(s) {
  if (s == null) return null;
  return String(s)
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[     ]/g, ' ')
    .replace(/[​‌‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein distance, two-row DP, inputs capped.
 *
 * The cap matters: this is the only super-linear thing in the whole pipeline,
 * and 200x200 is 40k cell updates, which is negligible. Uncapped, a 400-char
 * meta description pair would be 160k, still fine, but the cap makes the worst
 * case a constant we can reason about.
 */
export function editDistance(a, b, cap = 200) {
  const s = (a ?? '').slice(0, cap);
  const t = (b ?? '').slice(0, cap);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j++) {
      const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

/** 0 = identical, 1 = nothing in common. */
export function textMagnitude(a, b) {
  const s = canonical(a) ?? '';
  const t = canonical(b) ?? '';
  const span = Math.max(s.length, t.length, 1);
  return Math.min(1, editDistance(s, t) / Math.min(span, 200));
}

/** Parse a list signal's stored value back into items. */
export function listItems(value, json) {
  if (json) {
    const parsed = typeof json === 'string' ? safeJson(json) : json;
    if (parsed) {
      if (Array.isArray(parsed.names)) return parsed.names;
      if (Array.isArray(parsed.items)) return parsed.items.map((i) => i.claim ?? String(i));
      if (Array.isArray(parsed.tiers)) return parsed.tiers.map((t) => t.name ?? String(t));
    }
  }
  if (!value) return [];
  return value.split(/\s*\|\s*|,\s*/).map((s) => s.trim()).filter(Boolean);
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** Jaccard distance over lowercased items, plus the added/removed breakdown. */
export function listDelta(beforeItems, afterItems) {
  const A = new Set(beforeItems.map((s) => s.toLowerCase()));
  const B = new Set(afterItems.map((s) => s.toLowerCase()));
  const added = afterItems.filter((s) => !A.has(s.toLowerCase()));
  const removed = beforeItems.filter((s) => !B.has(s.toLowerCase()));
  const union = new Set([...A, ...B]).size || 1;
  const inter = [...A].filter((s) => B.has(s)).length;
  return { added, removed, magnitude: 1 - inter / union };
}

// ------------------------------------------------------------- page-level gate

/**
 * Decide whether a page's signals may be diffed at all.
 *
 * `previousYield` is the number of signals that produced a value on the last
 * successful run of this page. `currentYield` is this run's. Returns
 * { diffable, status, reason, originShift }, where `status` is written straight
 * to the run ledger and the observation.
 *
 * `origin` / `previousOrigin` are the crawl origins of this observation and of
 * the last one (src/crawl/origin.js). Unlike every other gate here, an origin
 * shift does NOT close the gate: the hero headline of a US-routed page is still
 * comparable with the hero headline of a German-routed one, and muting the whole
 * page would throw away real signal to protect the price fields. It is the
 * price fields that get protected, one rule down, in diffSignal.
 */
export function gatePage({
  fetchOk,
  fetchReason = null,
  extraction,
  previous = {},
  currentYield,
  previousYield,
  origin = null,
  previousOrigin = null,
}) {
  if (!fetchOk) {
    return { diffable: false, status: 'error', reason: fetchReason ?? 'fetch failed', rebaseline: false };
  }

  if (!extraction.extractable) {
    return {
      diffable: false,
      status: 'blocked',
      reason: `server returned a non-HTML variant (${extraction.variant}); the human-facing page is not observable`,
      rebaseline: false,
    };
  }

  // P5 -- our own change. Re-baseline silently so that tomorrow's run compares
  // like with like, and never attribute our version bump to the company.
  if (previous.extractorVersion && previous.extractorVersion !== extraction.extractorVersion) {
    return {
      diffable: false,
      status: 'ok',
      reason: `extractor ${previous.extractorVersion} -> ${extraction.extractorVersion}; re-baselining`,
      rebaseline: true,
    };
  }

  // P3 -- HTML one day, markdown the next. Not comparable.
  if (previous.variant && previous.variant !== extraction.variant) {
    return {
      diffable: false,
      status: 'changed-structure',
      reason: `content variant ${previous.variant} -> ${extraction.variant}`,
      rebaseline: true,
    };
  }

  // P2 -- localisation. Confirmed live: klaviyo.com, stripe.com, zendesk.com and
  // snowflake.com all redirect a European client to a translated page. The
  // headline is different because the language is different.
  if (previous.lang && extraction.lang && previous.lang !== extraction.lang) {
    return {
      diffable: false,
      status: 'ok',
      reason: `page language ${previous.lang} -> ${extraction.lang}; locale shift, not drift`,
      rebaseline: true,
    };
  }
  if (previous.canonical && extraction.canonical && previous.canonical !== extraction.canonical) {
    return {
      diffable: false,
      status: 'ok',
      reason: `canonical URL moved ${previous.canonical} -> ${extraction.canonical}`,
      rebaseline: true,
    };
  }

  // P4 -- the page still parses as HTML but we suddenly understand far less of
  // it. That is a redesign. Record the observations, publish nothing.
  if (previousYield >= 3 && currentYield < previousYield * STRUCTURE_YIELD_RATIO) {
    return {
      diffable: false,
      status: 'changed-structure',
      reason: `signal yield fell ${previousYield} -> ${currentYield}; page restructured, extractor needs review`,
      rebaseline: false,
    };
  }

  // P6 -- the page is fine; we moved. notion.com/pricing quotes EUR to a German
  // address and USD to a US one, with the same <html lang="en"> and the same
  // canonical URL, so P2 sees nothing. The observation is recorded, the run is
  // classified `origin-shift` so the ledger says why, and the price signals stay
  // unpublished.
  if (originsDiffer(previousOrigin, origin) === 'different') {
    return {
      diffable: true,
      status: 'origin-shift',
      reason: `crawl origin ${describeOrigin(previousOrigin)} -> ${describeOrigin(origin)}; ` +
        'locale-sensitive signals are not comparable across it',
      rebaseline: false,
      originShift: true,
    };
  }

  return { diffable: true, status: 'ok', reason: null, rebaseline: false, originShift: false };
}

/**
 * Positive evidence that a value appearing where there was none is OUR extractor
 * recovering rather than THEIR page gaining something.
 *
 * S10 withholds the claim either way, so none of this changes what is published.
 * What it changes is what the recorded reason is allowed to say, and that is not
 * cosmetic: the reason string is what somebody auditing this archive in a year
 * has to work with, and "we could not tell" and "we could tell, and it was us"
 * are different findings that must not be written down the same way.
 *
 * Facts are read from the PREVIOUS observation of the page, because the question
 * is whether the previous read was broken, not whether this one is.
 *
 * @returns {string[]} the evidence, phrased for the reason string
 */
export function recoveryEvidence({
  previousStatus = null,
  previousYield = null,
  currentYield = null,
  previousExtractorVersion = null,
  extractorVersion = null,
  states = {},
} = {}) {
  const found = [];

  if (previousStatus === 'changed-structure') {
    found.push('the previous read of this page was classified changed-structure');
  }

  // Normally unreachable, and kept anyway: P5 closes the gate on a version bump
  // and re-baselines before any signal is diffed. This catches the case P5
  // cannot -- a previous observation recorded before the extractor version was
  // written down at all, which is most of the archive's first day.
  if (previousExtractorVersion && extractorVersion && previousExtractorVersion !== extractorVersion) {
    found.push(`the extractor moved ${previousExtractorVersion} -> ${extractorVersion} since the previous read`);
  }

  // The mirror of P4. P4 asks whether the yield collapsed since last time and
  // calls that a redesign; this asks whether it recovered, on the same threshold,
  // and calls that our selectors coming back.
  if (
    typeof previousYield === 'number' && typeof currentYield === 'number' &&
    currentYield >= 3 && previousYield < currentYield * STRUCTURE_YIELD_RATIO
  ) {
    found.push(`signal yield rose ${previousYield} -> ${currentYield} since the previous read`);
  }

  // A signal that HAD a value and lost it is in a parser fault right now. One of
  // those on the page means the extractor was demonstrably mis-reading it at the
  // moment the acquired signal was reading null.
  if (Object.values(states).some((s) => (s?.consecutive_nulls ?? 0) > 0 && s?.last_good_value != null)) {
    found.push('another signal on this page was in a parser fault at the previous read');
  }

  return found;
}

/**
 * Make an observed value the signal's known-good baseline.
 *
 * Pure, so that the two places that adopt a value -- a normal successful diff,
 * and a pending acquisition corroborated by a byte-identical re-read -- cannot
 * drift into adopting it differently.
 *
 * @param {object} state    the state to build on
 * @param {object} current  { value, hash?, json?, method?, confidence? }
 */
export function adoptValue(state, current, now) {
  const hash = current.hash ?? fnv1a(canonical(current.value));
  const recent = parseRecent(state?.recent_hashes);
  const json = current.json == null ? null
    : typeof current.json === 'string' ? current.json : JSON.stringify(current.json);

  return {
    ...state,
    last_observed_at: now,
    last_good_at: now,
    last_good_value: current.value,
    last_good_json: json,
    last_good_hash: hash,
    last_good_method: current.method ?? null,
    last_good_confidence: current.confidence ?? null,
    consecutive_nulls: 0,
    suspect: 0,
    recent_hashes: JSON.stringify([hash, ...recent.filter((x) => x !== hash)].slice(0, RECENT_MEMORY)),
    currency_shift_runs: 0,
    currency_shift_key: null,
    acquisition_runs: 0,
    acquisition_hash: null,
  };
}

/**
 * Advance a pending S10 acquisition across a read that returned identical bytes.
 *
 * A conditional GET that comes back 304, or a body whose hash has not moved,
 * short-circuits before extraction -- there is nothing to extract that we have
 * not already extracted. That is the STRONGEST corroboration a value can get:
 * the bytes that produced it have not moved, so the value has not either.
 *
 * Without this the counter could only advance on runs where something else on
 * the page happened to change, and a value on a stable page would stay
 * unadopted indefinitely -- shown on the public site as a signal we do not
 * extract, when in fact we have extracted it every day for a week. That is the
 * exact species of quiet dishonesty this project is built to avoid.
 *
 * @param {object|null} record  the last stored observation of this page
 * @returns {object|null} a new state map, or null if nothing was pending
 */
export function corroborateAcquisitions(record, now) {
  if (!record?.state) return null;

  const out = {};
  let advanced = 0;
  for (const [signal, state] of Object.entries(record.state)) {
    const observed = record.signals?.[signal] ?? null;
    const pending = state && state.last_good_value == null && (state.acquisition_runs ?? 0) > 0;

    // The hash check is belt and braces: identical bytes cannot yield a
    // different value, and if they somehow did we would rather count nothing.
    if (!pending || !observed?.value || observed.hash !== state.acquisition_hash) {
      out[signal] = { ...state };
      continue;
    }

    advanced++;
    const runs = (state.acquisition_runs ?? 0) + 1;
    out[signal] = runs >= ACQUISITION_CONFIRMATIONS
      ? adoptValue(state, observed, now)
      : { ...state, last_observed_at: now, acquisition_runs: runs };
  }

  return advanced ? out : null;
}

// ----------------------------------------------------------- signal-level diff

/**
 * Diff one signal against its stored state.
 *
 * @param {object} args
 * @param {string} args.signal        signal name, must exist in SIGNALS
 * @param {object|null} args.current  { value, json, method, confidence } or null
 * @param {object|null} args.state    signal_state row, or null if never seen
 * @param {boolean} args.pageHealthy  did the rest of the page extract normally
 * @param {string} args.now           ISO timestamp for this run
 * @param {boolean} [args.originShift] did this page's crawl origin move since the
 *                                     last observation (src/crawl/origin.js)
 * @param {string} [args.originId]     the current origin's comparison key, used
 *                                     to require that a currency change is
 *                                     corroborated from a STABLE vantage point
 * @param {string[]} [args.recovery]   page-level evidence that this run's
 *                                     extraction recovered from a broken one
 *                                     (recoveryEvidence, below); read by S10
 *
 * @returns {{outcome: string, reason: string|null, event: object|null, state: object}}
 */
export function diffSignal({
  signal, current, state, pageHealthy = true, now,
  originShift = false, originId = 'unknown', recovery = [],
}) {
  const meta = SIGNALS[signal];
  if (!meta) throw new Error(`unknown signal: ${signal}`);

  const value = current?.value ?? null;
  const hash = value ? fnv1a(canonical(value)) : null;

  const nextState = {
    signal,
    last_observed_at: now,
    last_good_at: state?.last_good_at ?? null,
    last_good_value: state?.last_good_value ?? null,
    last_good_json: state?.last_good_json ?? null,
    last_good_hash: state?.last_good_hash ?? null,
    last_good_method: state?.last_good_method ?? null,
    last_good_confidence: state?.last_good_confidence ?? null,
    consecutive_nulls: state?.consecutive_nulls ?? 0,
    suspect: state?.suspect ? 1 : 0,
    total_changes: state?.total_changes ?? 0,
    recent_hashes: state?.recent_hashes ?? null,
    currency_shift_runs: state?.currency_shift_runs ?? 0,
    currency_shift_key: state?.currency_shift_key ?? null,
    acquisition_runs: state?.acquisition_runs ?? 0,
    acquisition_hash: state?.acquisition_hash ?? null,
  };

  const settle = (outcome, reason = null, event = null) => ({ outcome, reason, event, state: nextState });

  /** Hashes this signal has held recently, newest first. */
  const recent = parseRecent(state?.recent_hashes);

  const commitGood = () => {
    Object.assign(nextState, adoptValue(nextState, {
      value, hash, json: current?.json, method: current?.method, confidence: current?.confidence,
    }, now));
  };

  // ---- S1: never seen before. Establish the baseline, publish nothing.
  //
  // Without this, day one of the index would emit ~700 "added" events and the
  // feed would be meaningless. A signal appearing for the FIRST time after we
  // already have state for it (below) is a genuine `added` event.
  if (!state) {
    if (value) commitGood();
    else nextState.consecutive_nulls = 1;
    return settle(value ? 'baseline' : 'baseline-empty');
  }

  // ---- S2: we had a value, now we have nothing. This is the single most
  // important branch in the project. It is NOT a change event.
  if (!value) {
    nextState.consecutive_nulls = (state.consecutive_nulls ?? 0) + 1;

    if (!state.last_good_value) {
      // Never had a value. Nothing to fault, nothing to report.
      return settle('no-data');
    }

    nextState.suspect = nextState.consecutive_nulls >= SUSPECT_AFTER ? 1 : 0;

    // ---- S3: sustained absence on an otherwise healthy page. Only now are we
    // willing to say the company took it down.
    if (pageHealthy && nextState.consecutive_nulls >= REMOVAL_CONFIRMATIONS) {
      const event = {
        signal,
        change_type: 'removed',
        before_value: state.last_good_value,
        after_value: null,
        before_json: state.last_good_json ?? null,
        after_json: null,
        previous_seen_at: state.last_good_at,
        magnitude: 1,
        summary: summarise(signal, 'removed', state.last_good_value, null, meta),
      };
      // Reset so we do not re-emit the same removal every subsequent run.
      nextState.last_good_value = null;
      nextState.last_good_json = null;
      nextState.last_good_hash = null;
      nextState.last_good_at = null;
      nextState.consecutive_nulls = 0;
      nextState.suspect = 0;
      nextState.total_changes = (state.total_changes ?? 0) + 1;
      return settle('confirmed-removal', `absent for ${REMOVAL_CONFIRMATIONS} consecutive runs`, event);
    }

    return settle(
      'parser-fault',
      `extractor returned null where it previously returned a value (run ${nextState.consecutive_nulls} of ${REMOVAL_CONFIRMATIONS})`
    );
  }

  // ---- We have a value. Was there a previous one?
  const before = state.last_good_value;

  // ---- S10: nothing before, something now. The mirror image of S2, and the
  // rule this engine spent its first 45 commits without.
  //
  // "Our extractor finally succeeded" and "the company finally added it" are the
  // same transition. Nothing in the pair distinguishes them: a logo wall
  // rendered from CSS sprites that later ships as plain <img> tags looks
  // identical, in the data, to a logo wall that did not exist last week.
  // Publishing it asserts the second reading when the first is at least as
  // likely, and "company X added Y" is exactly the kind of claim a reader would
  // act on and could check. So the observation is recorded and the claim is not
  // made -- the same trade S2 makes in the other direction.
  //
  // The value is not adopted as the baseline until it has been read again,
  // unchanged, from a healthy page, ACQUISITION_CONFIRMATIONS times. Until then
  // the signal keeps comparing against nothing, exactly as S4 and S8 keep
  // comparing against the last value we were confident about.
  if (!before) {
    const evidence = [...recovery];
    if (state.suspect) {
      evidence.push('this signal was flagged as a suspected extraction failure before the value appeared');
    }

    // The extractor is producing output again, so the null streak is over and
    // nothing about this signal is a suspected failure any more. What is not yet
    // established is the VALUE, and that is what the acquisition counter tracks.
    nextState.consecutive_nulls = 0;
    nextState.suspect = 0;
    nextState.acquisition_hash = hash;
    nextState.acquisition_runs = !pageHealthy
      ? 0
      : state.acquisition_hash === hash ? (state.acquisition_runs ?? 0) + 1 : 1;

    const descriptor = `${meta.label.toLowerCase()} now extracts as ${q(value)} where the signal had no value`;

    if (nextState.acquisition_runs >= ACQUISITION_CONFIRMATIONS) {
      commitGood();
      return settle(
        'acquisition-adopted',
        `${descriptor}; unchanged across ${ACQUISITION_CONFIRMATIONS} consecutive healthy reads, ` +
        'so it is adopted as the baseline without publishing a change, because a value appearing ' +
        'where there was none cannot be told apart from an extractor that finally succeeded'
      );
    }

    return settle(
      'acquisition',
      `${descriptor}; recorded as a signal acquisition rather than an addition, because ` +
      (evidence.length
        ? `this reads with high confidence as extractor recovery rather than a real addition (${evidence.join('; ')})`
        : 'an extractor that finally succeeded and a page that finally gained the thing are the same transition') +
      ` (corroboration ${nextState.acquisition_runs} of ${ACQUISITION_CONFIRMATIONS})`
    );
  }

  // ---- S6: identical after canonicalisation.
  if (canonical(before) === canonical(value)) {
    commitGood();
    return settle('unchanged');
  }

  // ---- S4: the extractor fell back to a weaker strategy AND the value moved.
  // Attribute that to ourselves, not to them.
  const prevConf = state.last_good_confidence;
  if (
    typeof prevConf === 'number' &&
    typeof current?.confidence === 'number' &&
    prevConf - current.confidence >= CONFIDENCE_DROP &&
    state.last_good_method !== current.method
  ) {
    nextState.suspect = 1;
    // Note we do NOT commit the weaker value as the new baseline: keep comparing
    // against the last thing we were confident about.
    return settle(
      'suppressed',
      `extraction method downgraded ${state.last_good_method} (${prevConf}) -> ${current.method} (${current.confidence}); ` +
      'value difference attributed to the fallback, not to the page'
    );
  }

  const before_ = { value: before, json: state.last_good_json ?? null };
  const after_ = { value, json: current?.json ?? null };

  // ---- S8: we moved, they did not. The sibling of S2.
  //
  // A price that reads EUR 9.5 from Frankfurt and USD 10 from Virginia has not
  // moved; we have. The observation is already recorded by the caller; what is
  // withheld is the claim. The last known-good value is deliberately NOT
  // overwritten, exactly as in S4: the next reading from the origin we baselined
  // against must diff against what we actually believed, not against a value we
  // only saw because we were standing somewhere else.
  if (originShift && localeSensitive(signal, before_, after_)) {
    nextState.suspect = 1;
    nextState.currency_shift_runs = 0;
    nextState.currency_shift_key = null;
    return settle(
      'origin-shift',
      `${meta.label.toLowerCase()} differs across a change of crawl origin; ` +
      'a locale-sensitive value observed from a different vantage point is a context fault, not drift'
    );
  }

  // ---- S9: the currency moved and the numbers came with it, proportionately.
  //
  // Strong evidence of locale routing even when the origin looks unchanged --
  // and origin can look unchanged for two honest reasons: the observation
  // predates origin recording, or the origin probe failed and returned unknown.
  // This rule needs neither. It needs corroboration instead: the same currency,
  // from the same origin, CURRENCY_CONFIRMATIONS times, before the new value is
  // adopted -- and even then it is adopted silently, never published.
  const shift = currencyShift(before_, after_);
  if (shift && shift.proportionate) {
    const key = `${shift.to}@${originId}`;
    nextState.currency_shift_key = key;
    nextState.currency_shift_runs = state.currency_shift_key === key ? (state.currency_shift_runs ?? 0) + 1 : 1;

    if (nextState.currency_shift_runs >= CURRENCY_CONFIRMATIONS) {
      commitGood();
      return settle(
        'currency-rebaselined',
        `${shift.from} -> ${shift.to} held for ${CURRENCY_CONFIRMATIONS} consecutive observations from ${originId}; ` +
        'adopting the new baseline without publishing a change, because a currency-only move ' +
        'cannot be told apart from locale routing'
      );
    }

    nextState.suspect = 1;
    return settle(
      'currency-shift',
      `currency ${shift.from} -> ${shift.to} with amounts moving proportionately ` +
      `(x${shift.min.toFixed(3)}-${shift.max.toFixed(3)}); reads as locale routing rather than repricing ` +
      `(corroboration ${nextState.currency_shift_runs} of ${CURRENCY_CONFIRMATIONS})`
    );
  }

  // ---- S5: list collapse.
  if (meta.kind === 'list') {
    const beforeItems = listItems(before, state.last_good_json);
    const afterItems = listItems(value, current?.json);
    if (beforeItems.length >= 4 && afterItems.length < beforeItems.length * LIST_COLLAPSE_RATIO) {
      nextState.suspect = 1;
      return settle(
        'suppressed',
        `list collapsed ${beforeItems.length} -> ${afterItems.length} items; ` +
        'below the threshold where a real removal is more likely than a selector break'
      );
    }
    const { added, removed, magnitude } = listDelta(beforeItems, afterItems);
    commitGood();
    nextState.total_changes = (state.total_changes ?? 0) + 1;
    return settle('changed', null, {
      signal,
      change_type: 'modified',
      before_value: before,
      after_value: value,
      before_json: state.last_good_json ?? null,
      after_json: current?.json ? JSON.stringify(current.json) : null,
      previous_seen_at: state.last_good_at,
      magnitude: Number(magnitude.toFixed(3)),
      oscillating: recent.includes(hash) ? 1 : 0,
      summary: summariseList(signal, added, removed, meta),
    });
  }

  // ---- S7: a real change.
  const oscillates = recent.includes(hash);
  commitGood();
  nextState.total_changes = (state.total_changes ?? 0) + 1;
  return settle('changed', null, {
    signal,
    change_type: 'modified',
    before_value: before,
    after_value: value,
    before_json: state.last_good_json ?? null,
    after_json: current?.json ? JSON.stringify(current.json) : null,
    previous_seen_at: state.last_good_at,
    magnitude: Number(textMagnitude(before, value).toFixed(3)),
    // Back to something it recently was: an experiment cycling, not a rewrite.
    oscillating: oscillates ? 1 : 0,
    summary: oscillates
      ? `${summarise(signal, 'modified', before, value, meta)} (a value this page has held recently -- likely an A/B test rather than a repositioning)`
      : summarise(signal, 'modified', before, value, meta),
  });
}

function parseRecent(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ summaries

const q = (s) => (s == null ? 'nothing' : `"${String(s).length > 90 ? String(s).slice(0, 87) + '…' : s}"`);

const PHRASING = {
  headline:            { modified: (a, b) => `Hero headline changed from ${q(a)} to ${q(b)}` },
  subhead:             { modified: (a, b) => `Hero subhead changed from ${q(a)} to ${q(b)}` },
  category_label:      { modified: (a, b) => `Now calls itself ${q(b)} (was ${q(a)})` },
  meta_title:          { modified: (a, b) => `Meta title changed from ${q(a)} to ${q(b)}` },
  meta_description:    { modified: (a, b) => `Meta description rewritten` },
  pricing_entry_price: { modified: (a, b) => `Entry price moved from ${a} to ${b}` },
  pricing_free_tier:   { modified: (a, b) => (b === 'no' ? 'Free tier no longer published' : 'Free tier now published') },
  pricing_seat_minimum:{ modified: (a, b) => `Seat minimum changed from ${a} to ${b}`, removed: (a) => `Dropped its ${a} seat minimum` },
  pricing_meta_title:  { modified: (a, b) => `Pricing page title changed from ${q(a)} to ${q(b)}` },
};

/**
 * There is no `added` phrasing here, and that is not an omission. Since S10 the
 * engine emits no `added` events at all: a value appearing where there was none
 * is recorded as an acquisition and adopted silently. The only summaries that
 * reach the public feed describe a value that moved between two things we
 * actually observed, or one that went away and stayed away.
 */
function summarise(signal, type, before, after, meta) {
  const custom = PHRASING[signal]?.[type];
  if (custom) return custom(before, after);
  if (type === 'removed') return `${meta.label} no longer published (was ${q(before)})`;
  return `${meta.label} changed from ${q(before)} to ${q(after)}`;
}

function summariseList(signal, added, removed, meta) {
  const noun = meta.label.toLowerCase();
  const bits = [];
  if (added.length) bits.push(`added ${added.slice(0, 4).join(', ')}${added.length > 4 ? ` +${added.length - 4} more` : ''}`);
  if (removed.length) bits.push(`removed ${removed.slice(0, 4).join(', ')}${removed.length > 4 ? ` +${removed.length - 4} more` : ''}`);
  if (!bits.length) return `${meta.label} reordered`;
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}: ${bits.join('; ')}`;
}

// ------------------------------------------------------------------ page diff

/**
 * Diff every signal on a page. Applies the page-level gate first; when the gate
 * closes, every signal is still observed and stored (the time series stays
 * complete) but no events are produced.
 *
 * `previous` carries the page-level facts of the previous observation --
 * `{ status, yield, extractorVersion }` straight off the last line of the
 * company's file. They are not needed to decide anything; they are what lets S10
 * say WHY a value appeared, rather than only that it did.
 */
export function diffPage({ extraction, states, gate, now, origin = null, previous = {} }) {
  const results = [];
  const events = [];

  const signalNames = Object.keys(extraction.signals);
  const currentYield = signalNames.filter((s) => extraction.signals[s]).length;
  const pageHealthy = gate.diffable && currentYield >= Math.max(1, Math.ceil(signalNames.length * 0.5));

  const recovery = recoveryEvidence({
    previousStatus: previous.status ?? null,
    previousYield: typeof previous.yield === 'number' ? previous.yield : null,
    currentYield,
    previousExtractorVersion: previous.extractorVersion ?? null,
    extractorVersion: extraction.extractorVersion ?? null,
    states,
  });

  for (const signal of signalNames) {
    const current = extraction.signals[signal];
    const state = states[signal] ?? null;

    if (!gate.diffable) {
      // Keep state fresh enough that tomorrow compares against today, but never
      // emit an event and never advance the null counters on a page we could
      // not fairly read.
      const carried = { ...(state ?? emptyState(signal)), last_observed_at: now };
      if (gate.rebaseline && current?.value) {
        carried.last_good_at = now;
        carried.last_good_value = current.value;
        carried.last_good_json = current.json ? JSON.stringify(current.json) : null;
        carried.last_good_hash = fnv1a(canonical(current.value));
        carried.last_good_method = current.method;
        carried.last_good_confidence = current.confidence;
        carried.consecutive_nulls = 0;
        carried.acquisition_runs = 0;
        carried.acquisition_hash = null;
      }
      results.push({ signal, outcome: 'suppressed', reason: gate.reason, event: null, state: carried });
      continue;
    }

    const r = diffSignal({
      signal, current, state, pageHealthy, now,
      originShift: gate.originShift === true,
      originId: origin?.id ?? 'unknown',
      recovery,
    });
    results.push(r);
    if (r.event) events.push(r.event);
  }

  return { results, events, currentYield, pageHealthy };
}

export function emptyState(signal) {
  return {
    signal,
    last_observed_at: null,
    last_good_at: null,
    last_good_value: null,
    last_good_json: null,
    last_good_hash: null,
    last_good_method: null,
    last_good_confidence: null,
    consecutive_nulls: 0,
    suspect: 0,
    total_changes: 0,
    recent_hashes: null,
    currency_shift_runs: 0,
    currency_shift_key: null,
    acquisition_runs: 0,
    acquisition_hash: null,
  };
}
