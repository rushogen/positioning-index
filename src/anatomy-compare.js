/**
 * One page, and one section of it, placed against the corpus.
 *
 * anatomy-insights.js answers "how are these pages built". This file turns the
 * same numbers around to face a single company: where does this page sit in the
 * distribution, and who else does what it does. It returns plain data, never
 * HTML, because the renderer has a job this file must not do for it -- making
 * the difference between a measurement and a judgement visible at a glance.
 *
 * THE RULES, UNCHANGED
 * --------------------
 *   1. A null is "not readable", never zero and never absent. A page with no
 *      readable sequence is not a page with no sections; it is named and
 *      excluded from the denominator rather than counted as an empty one.
 *   2. Nothing is imputed. A missing value produces a null and a reason, not a
 *      median stood in for it.
 *   3. Every percentage carries the n that produced it. Every string in the
 *      returned object goes through `shareText` or `pctOf`, both of which
 *      refuse to emit a bare percentage; tests/anatomy-compare.test.js walks the
 *      whole return value and fails on one.
 *   4. Every claim names the companies behind it. Lists are capped at
 *      `PEER_LIMIT`, and a capped list reports how many it is not showing --
 *      a truncated list presented as complete is the exact failure this project
 *      exists to avoid.
 *   5. Generated from the numbers, never typed next to them. Nothing below is a
 *      sentence that would survive a different value.
 *
 * AND THE ONE THIS FILE ADDS
 * --------------------------
 *   6. MEASURED AND JUDGED ARE NOT THE SAME KIND OF FACT, SO THEY ARE NOT IN THE
 *      SAME LIST. A word count is bytes on a page: it is in `measured`, and it
 *      carries no caveat because there is nothing to caveat. A section *type* is
 *      this project's opinion about a span of markup: it is in `judged`, and
 *      every entry there carries the classifier's measured accuracy inline --
 *      not once at the bottom of the page, but on the claim itself, because a
 *      caveat a reader has to go looking for is a caveat that did not happen.
 *
 * A NOTE ON WORDING
 * -----------------
 * A position in a distribution is not a grade. "1,499 words, above the p75 of
 * 1,300 across 58 readable pages" is a fact; "too long" is an opinion about a
 * business this project knows nothing about. There is no scoring here and there
 * will not be.
 */

// ------------------------------------------------------- classifier accuracy

/**
 * The last score `scripts/score-anatomy.js` produced, as raw counts.
 *
 * Counts, not ratios, so that every percentage published from it is derived
 * here rather than typed here -- the same reason no other number in this
 * repository is hand-written. Re-run the command below after any change to
 * src/extract/anatomy.js or seed/labels.json and update these five numbers; the
 * caveat text, the ratios and the phrasing all follow from them.
 *
 *   $ node scripts/score-anatomy.js
 *   labelled pages    44
 *   labelled sections 168 matched, 30 unmatched by heading
 *   ACCURACY           50%  (84/168)
 *     excluding hero   34%  (43/126)   <- the hard part
 *
 * The two numbers are different questions. Hero is position one and is nearly
 * free, so the overall figure rises when pages are added rather than when the
 * classifier improves. `non_hero` is the one that describes every section a
 * reader is actually curious about, and it is the one this file leads with.
 */
export const CLASSIFIER_ACCURACY = {
  labelled_pages: 44,
  matched: 168,
  correct: 84,
  non_hero: 126,
  non_hero_correct: 43,
  measured_at: '2026-08-08',
  command: 'node scripts/score-anatomy.js',
  source: 'scripts/score-anatomy.js against seed/labels.json',
};

/** How far the peer lists are allowed to run before they say so. */
export const PEER_LIMIT = 8;

/**
 * Human labels for the section vocabulary.
 *
 * Mirrors the map in anatomy-view.js and covers every entry of SECTION_TYPES,
 * including the five that view currently falls through on. The keys are the
 * published values, so a renderer can always fall back to the raw type.
 */
export const TYPE_LABEL = {
  hero: 'Hero',
  logos: 'Logo wall',
  proof: 'Proof / numbers',
  testimonial: 'Testimonial',
  pricing: 'Pricing block',
  faq: 'FAQ',
  comparison: 'Comparison table',
  integrations: 'Integrations',
  features: 'Feature grid',
  product: 'Product walkthrough',
  resources: 'Resources',
  awards: 'Awards / badges',
  events: 'Events',
  security: 'Security / compliance',
  cta: 'Call to action',
  media: 'Video / media',
  other: 'Unclassified',
};

/** The label for a section type, or the raw type if it has no label yet. */
export const typeLabel = (t) => (t == null ? null : TYPE_LABEL[t] ?? t);

/**
 * The same vocabulary as a noun phrase that can sit inside a sentence.
 *
 * A second map rather than `TYPE_LABEL[t].toLowerCase()` because that produces
 * "put a faq here" and "have a unclassified there". The labels are titles for a
 * renderer to print; these are English, and the two jobs are different enough
 * that trying to do both from one string is how the copy goes wrong.
 */
export const TYPE_PHRASE = {
  hero: 'a hero',
  logos: 'a logo wall',
  proof: 'a proof or numbers block',
  testimonial: 'a testimonial',
  pricing: 'a pricing block',
  faq: 'an FAQ',
  comparison: 'a comparison table',
  integrations: 'an integrations block',
  features: 'a feature grid',
  product: 'a product walkthrough',
  resources: 'a resources block',
  awards: 'an awards or badges block',
  events: 'an events block',
  security: 'a security or compliance block',
  cta: 'a call to action',
  media: 'a video or media block',
  other: 'an unclassified section',
};

/** "an FAQ", "a feature grid", or a safe fallback for a type with no phrase yet. */
export const typePhrase = (t) => {
  if (t == null) return 'a section';
  if (TYPE_PHRASE[t]) return TYPE_PHRASE[t];
  return `${/^[aeiou]/i.test(t) ? 'an' : 'a'} ${t} section`;
};

// ----------------------------------------------------------------- primitives

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Thousands separators, so "1499 words" reads as the 1,499 it is. */
function num(v) {
  if (!isNum(v)) return null;
  const [whole, frac] = String(v).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** One decimal place, matching anatomy-insights.js. Null when there is no denominator. */
const pct = (n, of) => (!isNum(of) || of === 0 ? null : Math.round((n / of) * 1000) / 10);

/** "28%" or null. Never returned on its own -- see the two helpers below. */
function pctText(n, of) {
  const p = pct(n, of);
  return p === null ? null : `${p}%`;
}

/**
 * "47 of 166 (28%)".
 *
 * The only two functions in this file that may emit a `%`, and both of them put
 * the denominator in the same breath. A bare percentage cannot be produced here
 * even by accident.
 */
function shareText(n, of) {
  const p = pctText(n, of);
  return p === null ? `${num(n)} of ${num(of)}` : `${num(n)} of ${num(of)} (${p})`;
}

/** "28% of 166". */
function pctOf(n, of) {
  const p = pctText(n, of);
  return p === null ? `${num(n)} of ${num(of)}` : `${p} of ${num(of)}`;
}

function ordinal(n) {
  if (!isNum(n)) return null;
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${num(n)}th`;
  return `${num(n)}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en') || a.slug.localeCompare(b.slug, 'en');

/** The same quantile rule anatomy-insights.js uses, so the two never disagree. */
function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.5 * s.length))];
}

/**
 * A company list that is honest about being a list.
 *
 * `companies` is what the renderer prints; `n` is how many there actually are;
 * `omitted` is the difference and is never allowed to be implicit. A caller that
 * reads only `companies` still cannot claim completeness, because `note` says so
 * in words.
 */
export function peerBlock(companies, { limit = PEER_LIMIT, of = null, what = 'companies', excluded = null } = {}) {
  const all = (companies ?? [])
    .filter((c) => c && c.slug)
    .map((c) => ({ slug: c.slug, name: c.name }))
    .sort(byName);
  const shown = limit === null ? all : all.slice(0, limit);
  const omitted = all.length - shown.length;
  const tail = excluded ? ` Excludes ${excluded}.` : '';

  let note;
  if (!all.length) note = `No other ${what}.${tail}`;
  else if (!omitted) note = `All ${num(all.length)} listed, sorted by name.${tail}`;
  else note = `${num(shown.length)} of ${num(all.length)} listed, sorted by name; ${num(omitted)} not listed here.${tail}`;

  return {
    n: all.length,
    of,
    shown: shown.length,
    omitted,
    limit,
    truncated: omitted > 0,
    companies: shown,
    note,
  };
}

// ------------------------------------------------------- the published caveat

/** Ratios and counts for the classifier, derived from CLASSIFIER_ACCURACY. */
export function accuracyBlock(a = CLASSIFIER_ACCURACY) {
  const round2 = (n, of) => (of ? Math.round((n / of) * 100) / 100 : null);
  return {
    nonHero: round2(a.non_hero_correct, a.non_hero),
    nonHeroCorrect: a.non_hero_correct,
    nonHeroOf: a.non_hero,
    overall: round2(a.correct, a.matched),
    correct: a.correct,
    of: a.matched,
    labelledPages: a.labelled_pages,
    measuredAt: a.measured_at,
    command: a.command,
    source: a.source,
  };
}

/**
 * The sentence that goes beside every judged claim.
 *
 * Generated from the counts, so it cannot say 50% on a morning the classifier
 * scores 34%.
 */
export function classifierCaveat(a = CLASSIFIER_ACCURACY) {
  return (
    'A section type is this project’s judgement about a span of markup, not a value read off the page. '
    + `Scored by ${a.command} against the ${num(a.labelled_pages)} hand-labelled pages in seed/labels.json, `
    + `the classifier agreed with the human label on ${shareText(a.non_hero_correct, a.non_hero)} `
    + `non-hero sections, and on ${shareText(a.correct, a.matched)} sections including the hero, `
    + 'which is nearly free because it is whatever precedes the first h2. Read every type named here at '
    + 'that rate. Counted values — words, position, nav links, footer links — are measured off the page '
    + 'and carry no such caveat.'
  );
}

// ------------------------------------------------------------- corpus lookups

const stripsOf = (anatomy) => (anatomy?.companies ?? []).filter((c) => c && c.slug);

/** The company's row in the corpus, preferred over whatever the caller passed. */
function resolveCompany(company, anatomy) {
  const rows = stripsOf(anatomy);
  if (typeof company === 'string') return rows.find((c) => c.slug === company) ?? null;
  if (company && company.slug) return rows.find((c) => c.slug === company.slug) ?? company;
  return null;
}

/**
 * What the corpus puts at one position.
 *
 * Prefers the published profile in `anatomy.positions`, which stops at a fixed
 * depth. Past that depth the same answer is re-derived from the strips rather
 * than withheld -- a page with eleven sections has an eleventh section, and
 * saying nothing about it would be a gap in this file, not in the page. Which
 * source was used is reported, because the two are computed at different times
 * and a reader is entitled to know which one they are looking at.
 */
function slotProfile(position, anatomy) {
  const published = anatomy?.positions?.positions ?? [];
  const depth = published.length;
  const hit = published.find((p) => p.position === position);
  if (hit) {
    return { position, n: hit.n, types: hit.types, source: 'positions', depth, beyondPublishedDepth: false };
  }

  const at = stripsOf(anatomy)
    .map((c) => ({ c, type: c.sections?.[position - 1]?.type ?? null }))
    .filter((x) => x.type);

  const counts = new Map();
  for (const { c, type } of at) {
    if (!counts.has(type)) counts.set(type, []);
    counts.get(type).push({ slug: c.slug, name: c.name });
  }
  const types = [...counts.entries()]
    .map(([type, cos]) => ({ type, n: cos.length, share: pct(cos.length, at.length), companies: cos.sort(byName) }))
    .sort((a, b) => b.n - a.n || a.type.localeCompare(b.type));

  return { position, n: at.length, types, source: 'strips', depth, beyondPublishedDepth: depth > 0 && position > depth };
}

/** How many readable pages carry a type anywhere, from `elements` or from the strips. */
function prevalenceOf(type, anatomy) {
  const found = (anatomy?.elements?.elements ?? []).find((e) => e.type === type);
  if (found) {
    return { type, n: found.n, of: found.of, share: found.share, companies: found.companies ?? [], source: 'elements' };
  }
  const readable = stripsOf(anatomy).filter((c) => c.sections);
  const has = readable.filter((c) => c.sections.some((s) => s.type === type));
  return {
    type,
    n: has.length,
    of: readable.length,
    share: pct(has.length, readable.length),
    companies: has.map((c) => ({ slug: c.slug, name: c.name })).sort(byName),
    source: 'strips',
  };
}

// ------------------------------------------------------------ section insight

/**
 * One section of one page, against every other page's section at that position.
 *
 * `section` may be the section object from a strip or just its position.
 * `company` may be the strip, an object with a slug, or the slug itself.
 *
 * Returns `{ readable, present, measured[], judged[], peers, caveat, accuracy }`.
 * `measured` entries are counted off the page and have `caveat: null`. `judged`
 * entries rest on the classifier and each carry `caveat` and `accuracy` of their
 * own, so the renderer cannot print one without the other.
 */
export function sectionInsight({ section, company, anatomy, accuracy = CLASSIFIER_ACCURACY, peerLimit = PEER_LIMIT } = {}) {
  const acc = accuracyBlock(accuracy);
  const caveat = classifierCaveat(accuracy);
  const row = resolveCompany(company, anatomy);
  const who = row ? { slug: row.slug, name: row.name, segment: row.segment ?? null } : null;
  const sections = row?.sections ?? null;

  const askedPosition = isNum(section) ? section : section?.position ?? null;
  const sec = sections
    ? (isNum(section) ? sections.find((s) => s.position === section) ?? null : section ?? null)
    : (isNum(section) ? null : section ?? null);
  const position = sec?.position ?? askedPosition;

  const base = {
    kind: 'section',
    company: who,
    position,
    type: null,
    typeLabel: null,
    heading: null,
    words: null,
    readable: false,
    present: false,
    measured: [],
    judged: [],
    peers: peerBlock([], { limit: peerLimit, of: null, what: 'companies' }),
    caveat,
    accuracy: acc,
    notes: [],
  };

  if (!who) {
    return {
      ...base,
      notes: [{
        code: 'unknown-company',
        text: 'No company was resolved from the corpus, so there is nothing to compare. This is a wiring '
          + 'fault rather than a fact about any page.',
      }],
    };
  }

  // Rule 1. No readable sequence is an extraction gap, not a page without
  // sections, and it is said in those words rather than rendered as an empty
  // list that reads like an answer.
  if (!sections) {
    return {
      ...base,
      notes: [{
        code: 'no-readable-sequence',
        text: `${who.name} has no readable section sequence: the page’s bands are not h2-headed, so the `
          + 'extractor found nothing to cut on. That is a gap in what we can read, not a page built '
          + 'without sections, and it is why this page is absent from the position counts rather than '
          + 'counted as a page with none.',
      }],
    };
  }

  if (!sec) {
    return {
      ...base,
      readable: true,
      notes: [{
        code: 'no-section-at-position',
        text: `${who.name}’s sequence runs ${num(sections.length)} sections, so there is nothing at `
          + `position ${num(position)}.`,
      }],
    };
  }

  const type = sec.type ?? null;
  const notes = [];

  // ------------------------------------------------------------- measured
  const pageWords = sections.map((s) => s.words).filter(isNum);
  const pageMedian = median(pageWords);
  const readablePages = stripsOf(anatomy).filter((c) => c.sections);
  const corpusSectionWords = readablePages.flatMap((c) => c.sections.map((s) => s.words)).filter(isNum);
  const corpusSectionMedian = median(corpusSectionWords);
  const corpusSectionCountMedian = median(readablePages.map((c) => c.sections.length));

  const measured = [];

  measured.push({
    key: 'words',
    kind: 'measured',
    label: 'Words in this section',
    value: isNum(sec.words) ? sec.words : null,
    unit: 'words',
    comparison: !isNum(sec.words) || pageMedian === null
      ? null
      : `${num(sec.words)} words, against a median of ${num(pageMedian)} across the `
        + `${num(pageWords.length)} sections on this page`
        + (corpusSectionMedian === null
          ? ''
          : ` and ${num(corpusSectionMedian)} across the ${num(corpusSectionWords.length)} sections `
            + `on ${num(readablePages.length)} readable pages`),
    basis: {
      page_median: pageMedian,
      page_sections: pageWords.length,
      corpus_median: corpusSectionMedian,
      corpus_sections: corpusSectionWords.length,
      corpus_pages: readablePages.length,
    },
    note: isNum(sec.words) ? null : 'Section length did not extract for this section.',
    caveat: null,
  });

  measured.push({
    key: 'position',
    kind: 'measured',
    label: 'Where this section sits',
    value: position,
    unit: null,
    comparison: `section ${num(position)} of ${num(sections.length)} on this page`
      + (corpusSectionCountMedian === null
        ? ''
        : `, where the median page runs ${num(corpusSectionCountMedian)} sections across `
          + `${num(readablePages.length)} readable pages`),
    basis: {
      sections_on_page: sections.length,
      corpus_median_sections: corpusSectionCountMedian,
      corpus_pages: readablePages.length,
    },
    note: null,
    caveat: null,
  });

  // --------------------------------------------------------------- judged
  const slot = slotProfile(position, anatomy);
  if (slot.beyondPublishedDepth) {
    notes.push({
      code: 'beyond-published-depth',
      text: `The published position profile stops at position ${num(slot.depth)}. The counts for position `
        + `${num(position)} below are re-derived from the per-company sequences, over the `
        + `${num(slot.n)} pages whose sequence reaches that far.`,
    });
  }

  const mine = slot.types.find((t) => t.type === type) ?? null;
  const others = (mine?.companies ?? []).filter((c) => c.slug !== who.slug);
  const peers = peerBlock(others, {
    limit: peerLimit,
    of: slot.n,
    what: `${typeLabel(type) ?? 'section'} at position ${num(position)}`,
    excluded: who.name,
  });

  const judged = [];
  const top = slot.types[0] ?? null;
  const tied = top ? slot.types.filter((t) => t.n === top.n) : [];

  judged.push({
    key: 'slot_convention',
    kind: 'judged',
    label: `What sits in position ${num(position)}`,
    value: !top
      ? null
      : tied.length === 1
        ? `${pctOf(top.n, slot.n)} pages that reach position ${num(position)} put ${typePhrase(top.type)} here`
        : `${num(tied.length)} types tie at the top of position ${num(position)} — `
          + `${tied.map((t) => typePhrase(t.type)).join(', ')} — `
          + `each on ${shareText(top.n, slot.n)} pages that reach it`,
    n: top?.n ?? 0,
    of: slot.n,
    share: top?.share ?? null,
    ranking: slot.types.map((t) => ({
      type: t.type,
      typeLabel: typeLabel(t.type),
      n: t.n,
      of: slot.n,
      share: t.share,
      text: `${typeLabel(t.type)}: ${shareText(t.n, slot.n)}`,
      companies: peerBlock(t.companies, { limit: peerLimit, of: slot.n, what: 'companies' }),
    })),
    companies: peerBlock(top?.companies ?? [], { limit: peerLimit, of: slot.n, what: 'companies' }),
    basis: { source: slot.source, reach_position: slot.n, published_depth: slot.depth },
    note: slot.n ? null : `No page in the corpus has a readable section at position ${num(position)}.`,
    caveat,
    accuracy: acc,
  });

  const rankAmongTypes = mine ? slot.types.findIndex((t) => t.type === mine.type) + 1 : null;
  judged.push({
    key: 'same_type_here',
    kind: 'judged',
    label: `How often position ${num(position)} is ${typePhrase(type)}`,
    value: !mine
      ? null
      : `${shareText(mine.n, slot.n)} pages that reach position ${num(position)} have `
        + `${typePhrase(type)} there`
        // With one type at the slot the rank says nothing, and "the 1st most
        // common of the 1 types" is a sentence dressed up as a finding.
        + (rankAmongTypes && slot.types.length > 1
          ? `, the ${ordinal(rankAmongTypes)} most common of the ${num(slot.types.length)} types seen at this position`
          : ''),
    n: mine?.n ?? 0,
    of: slot.n,
    share: mine?.share ?? null,
    rank: rankAmongTypes,
    types_at_position: slot.types.length,
    companies: peers,
    basis: { source: slot.source, reach_position: slot.n },
    note: mine
      ? null
      : `The classifier read no page — not even ${who.name} — as having ${typePhrase(type)} `
        + `at position ${num(position)}.`,
    caveat,
    accuracy: acc,
  });

  const anywhere = type ? prevalenceOf(type, anatomy) : null;
  if (anywhere) {
    judged.push({
      key: 'type_anywhere',
      kind: 'judged',
      label: `Pages carrying ${typePhrase(type)} at all`,
      value: `${shareText(anywhere.n, anywhere.of)} readable pages carry ${typePhrase(type)} `
        + 'somewhere, in any position',
      n: anywhere.n,
      of: anywhere.of,
      share: anywhere.share,
      companies: peerBlock(anywhere.companies, { limit: peerLimit, of: anywhere.of, what: 'companies' }),
      basis: { source: anywhere.source },
      note: null,
      caveat,
      accuracy: acc,
    });
  }

  return {
    kind: 'section',
    company: who,
    position,
    type,
    typeLabel: typeLabel(type),
    heading: sec.heading ?? null,
    words: isNum(sec.words) ? sec.words : null,
    readable: true,
    present: true,
    measured,
    judged,
    peers,
    caveat,
    accuracy: acc,
    notes,
  };
}

// --------------------------------------------------------------- page insight

/**
 * Which scales this view places a page on, and where each one's value comes
 * from in the strip. The scale supplies the distribution; the strip supplies
 * this company's value; both come from the same signals, one crawl apart from
 * never disagreeing.
 */
const PAGE_SCALES = [
  { key: 'section_count', signal: 'anatomy_section_count', unit: 'sections', of: (c) => (c.sections ? c.sections.length : null) },
  { key: 'word_count', signal: 'anatomy_word_count', unit: 'words', of: (c) => (isNum(c.words) ? c.words : null) },
  { key: 'nav_links', signal: 'anatomy_nav_links', unit: 'links', of: (c) => (isNum(c.nav_links) ? c.nav_links : null) },
  { key: 'footer_links', signal: 'anatomy_footer_links', unit: 'links', of: (c) => (isNum(c.footer_links) ? c.footer_links : null) },
];

/**
 * Where a value falls between the published quantiles.
 *
 * A band, not a verdict. There is no "long", no "heavy" and no "should"; the
 * page is at a coordinate and the coordinate is named.
 */
function placement(value, s) {
  if (!isNum(value) || !isNum(s?.n) || s.n === 0) return null;
  const { min, p25, median: med, p75, max, n } = s;
  const over = `across ${num(n)} readable pages`;
  if (min === max) return { band: 'flat', text: `${num(value)}, the only value in the corpus ${over}` };
  if (value <= p25) return { band: 'at-or-below-p25', text: `at or below the p25 of ${num(p25)} ${over}` };
  if (value < med) return { band: 'between-p25-and-median', text: `between the p25 of ${num(p25)} and the median of ${num(med)} ${over}` };
  if (value === med) return { band: 'at-the-median', text: `at the median of ${num(med)} ${over}` };
  if (value <= p75) return { band: 'between-median-and-p75', text: `between the median of ${num(med)} and the p75 of ${num(p75)} ${over}` };
  return { band: 'above-p75', text: `above the p75 of ${num(p75)} ${over}` };
}

/** A checkable rank: how many readable pages sit above this value, by name. */
function rankOf(value, values) {
  if (!isNum(value) || !values.length) return null;
  const greater = values.filter((v) => v > value).length;
  const ties = values.filter((v) => v === value).length - 1;
  const place = greater + 1;
  let text = place === 1
    ? `the highest of ${num(values.length)} readable pages`
    : `${ordinal(place)} highest of ${num(values.length)} readable pages`;
  if (ties > 0) text += `, tied with ${num(ties)} other${ties === 1 ? '' : 's'}`;
  return { place, ties, of: values.length, text };
}

/**
 * The whole page against the corpus distribution.
 *
 * Section count, word count, nav links and footer links are counted off the
 * page, so they are `measured` and carry no caveat. The sequence of section
 * types is the classifier's opinion, so it is `judged` and carries one.
 */
export function pageInsight({ company, anatomy, accuracy = CLASSIFIER_ACCURACY, peerLimit = PEER_LIMIT } = {}) {
  const acc = accuracyBlock(accuracy);
  const caveat = classifierCaveat(accuracy);
  const row = resolveCompany(company, anatomy);
  const who = row ? { slug: row.slug, name: row.name, segment: row.segment ?? null } : null;
  const rows = stripsOf(anatomy);
  const readablePages = rows.filter((c) => c.sections);
  const notes = [];

  if (!who) {
    return {
      kind: 'page',
      company: null,
      readable: false,
      sequenceReadable: false,
      corpus: { tracked: rows.length, readable_sequences: readablePages.length },
      measured: [],
      judged: [],
      caveat,
      accuracy: acc,
      notes: [{
        code: 'unknown-company',
        text: 'No company was resolved from the corpus, so there is nothing to compare. This is a wiring '
          + 'fault rather than a fact about any page.',
      }],
    };
  }

  const scales = anatomy?.scales?.scales ?? [];

  const measured = PAGE_SCALES.map((spec) => {
    const scale = scales.find((s) => s.signal === spec.signal) ?? null;
    const value = spec.of(row);
    const values = rows.map(spec.of).filter(isNum);
    const has = isNum(scale?.n) && scale.n > 0;
    const place = has ? placement(value, scale) : null;
    const rank = rankOf(value, values);

    // Rule 1 twice over: a scale nothing was readable for is not a scale of
    // zeroes, and a page missing from it is not a page with none.
    let note = null;
    if (!has) {
      note = `No page in the corpus has a readable ${(scale?.label ?? spec.signal).toLowerCase()}, so there is `
        + 'no distribution to place this against. Not readable, not zero.';
    } else if (!isNum(value)) {
      note = `${(scale.label ?? spec.signal)} did not extract for ${who.name}. That is a gap in what we can `
        + `read, not a page with none — the distribution beside it is over `
        + `${num(scale.coverage?.readable ?? scale.n)} of ${num(scale.coverage?.tracked ?? rows.length)} pages.`;
    }

    return {
      key: spec.key,
      kind: 'measured',
      signal: spec.signal,
      label: scale?.label ?? spec.signal,
      value: isNum(value) ? value : null,
      unit: spec.unit,
      comparison: isNum(value) && place
        ? `${num(value)} ${spec.unit}, ${place.text}`
        : null,
      placement: place,
      rank,
      distribution: has
        ? { n: scale.n, min: scale.min, p25: scale.p25, median: scale.median, p75: scale.p75, max: scale.max }
        : { n: 0, min: null, p25: null, median: null, p75: null, max: null },
      coverage: scale?.coverage
        ? {
          tracked: scale.coverage.tracked,
          readable: scale.coverage.readable,
          unreadable: scale.coverage.unreadable,
          text: `Counted over ${num(scale.coverage.readable)} of ${num(scale.coverage.tracked)} pages.`,
        }
        : null,
      extremes: scale?.extremes ?? null,
      note,
      caveat: null,
    };
  });

  const judged = [];

  if (!row.sections) {
    notes.push({
      code: 'no-readable-sequence',
      text: `${who.name} has no readable section sequence: the page’s bands are not h2-headed. The counted `
        + `measures above still read, because they are not in doubt; the sequence below is absent because `
        + `we could not read it, not because the page has no sections. ${num(readablePages.length)} of `
        + `${num(rows.length)} pages in the corpus have a readable sequence.`,
    });
  } else {
    const sequence = row.sections.map((s) => s.type);
    const key = sequence.join(' > ');
    const same = readablePages.filter((c) => c.sections.map((s) => s.type).join(' > ') === key);
    const others = same.filter((c) => c.slug !== who.slug);

    judged.push({
      key: 'sequence',
      kind: 'judged',
      label: 'The sequence this page runs',
      value: key,
      sequence,
      sequenceLabels: sequence.map(typeLabel),
      n: same.length,
      of: readablePages.length,
      share: pct(same.length, readablePages.length),
      text: others.length
        ? `${shareText(same.length, readablePages.length)} readable pages run this exact sequence`
        : `No other readable page runs this exact sequence — ${shareText(same.length, readablePages.length)} `
          + 'readable pages match, and that one is this page',
      companies: peerBlock(others, {
        limit: peerLimit,
        of: readablePages.length,
        what: 'page with this sequence',
        excluded: who.name,
      }),
      note: null,
      caveat,
      accuracy: acc,
    });

    const carried = [...new Set(sequence)].sort();
    judged.push({
      key: 'elements_carried',
      kind: 'judged',
      label: 'What this page carries, and how usual that is',
      value: `${num(carried.length)} distinct section types across ${num(sequence.length)} sections`,
      items: carried.map((t) => {
        const p = prevalenceOf(t, anatomy);
        return {
          type: t,
          typeLabel: typeLabel(t),
          n: p.n,
          of: p.of,
          share: p.share,
          text: `${typeLabel(t)}: ${shareText(p.n, p.of)} readable pages carry one`,
          companies: peerBlock(p.companies, { limit: peerLimit, of: p.of, what: 'companies' }),
        };
      }),
      missing: (anatomy?.elements?.elements ?? [])
        .filter((e) => !carried.includes(e.type))
        .map((e) => ({
          type: e.type,
          typeLabel: typeLabel(e.type),
          n: e.n,
          of: e.of,
          share: e.share,
          text: `${typeLabel(e.type)}: on ${shareText(e.n, e.of)} readable pages, and not read on this one`,
        })),
      note: null,
      caveat,
      accuracy: acc,
    });
  }

  return {
    kind: 'page',
    company: who,
    readable: true,
    sequenceReadable: Boolean(row.sections),
    sections: row.sections ? row.sections.length : null,
    corpus: {
      tracked: rows.length,
      readable_sequences: readablePages.length,
      text: `${num(readablePages.length)} of ${num(rows.length)} pages in the corpus have a readable sequence.`,
    },
    measured,
    judged,
    caveat,
    accuracy: acc,
    notes,
  };
}
