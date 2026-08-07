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
 *
 *   SIGNAL LEVEL
 *   S1  No prior state                 -> baseline, no event.
 *   S2  null now, value before         -> PARSER FAULT. Never an event.
 *   S3  Sustained null + healthy page  -> confirmed removal, one event.
 *   S4  Confidence dropped sharply     -> suspect our method, not their copy.
 *   S5  List shrank past the threshold -> suspect our selector, not their logos.
 *   S6  Value equal after canonicalisation -> unchanged.
 *   S7  Otherwise                      -> a real change.
 */

import { fnv1a } from './hash.js';
import { SIGNALS } from './extract/index.js';

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
 * { diffable, status, reason }, where `status` is written straight to
 * fetches.status.
 */
export function gatePage({
  fetchOk,
  fetchReason = null,
  extraction,
  previous = {},
  currentYield,
  previousYield,
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

  return { diffable: true, status: 'ok', reason: null, rebaseline: false };
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
 *
 * @returns {{outcome: string, reason: string|null, event: object|null, state: object}}
 */
export function diffSignal({ signal, current, state, pageHealthy = true, now }) {
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
  };

  const settle = (outcome, reason = null, event = null) => ({ outcome, reason, event, state: nextState });

  /** Hashes this signal has held recently, newest first. */
  const recent = parseRecent(state?.recent_hashes);

  const commitGood = () => {
    nextState.recent_hashes = JSON.stringify(
      [hash, ...recent.filter((x) => x !== hash)].slice(0, RECENT_MEMORY)
    );
    nextState.last_good_at = now;
    nextState.last_good_value = value;
    nextState.last_good_json = current?.json ? JSON.stringify(current.json) : null;
    nextState.last_good_hash = hash;
    nextState.last_good_method = current?.method ?? null;
    nextState.last_good_confidence = current?.confidence ?? null;
    nextState.consecutive_nulls = 0;
    nextState.suspect = 0;
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

  if (!before) {
    commitGood();
    nextState.total_changes = (state.total_changes ?? 0) + 1;
    const event = {
      signal,
      change_type: 'added',
      before_value: null,
      after_value: value,
      before_json: null,
      after_json: current?.json ? JSON.stringify(current.json) : null,
      previous_seen_at: null,
      magnitude: 1,
      summary: summarise(signal, 'added', null, value, meta),
    };
    return settle('added', null, event);
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
  pricing_seat_minimum:{ modified: (a, b) => `Seat minimum changed from ${a} to ${b}`, added: (_, b) => `Introduced a seat minimum of ${b}`, removed: (a) => `Dropped its ${a} seat minimum` },
  pricing_meta_title:  { modified: (a, b) => `Pricing page title changed from ${q(a)} to ${q(b)}` },
};

function summarise(signal, type, before, after, meta) {
  const custom = PHRASING[signal]?.[type];
  if (custom) return custom(before, after);
  if (type === 'added') return `${meta.label} first observed: ${q(after)}`;
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
 */
export function diffPage({ extraction, states, gate, now }) {
  const results = [];
  const events = [];

  const signalNames = Object.keys(extraction.signals);
  const currentYield = signalNames.filter((s) => extraction.signals[s]).length;
  const pageHealthy = gate.diffable && currentYield >= Math.max(1, Math.ceil(signalNames.length * 0.5));

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
      }
      results.push({ signal, outcome: 'suppressed', reason: gate.reason, event: null, state: carried });
      continue;
    }

    const r = diffSignal({ signal, current, state, pageHealthy, now });
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
  };
}
