/**
 * The landing view: what 60 B2B SaaS companies are saying right now.
 *
 * This is rendered to a string at build time and written straight into
 * docs/index.html, which means the whole of the page's actual argument -- the
 * numbers, the charts, the coverage notes and the companies behind every bar --
 * is there before a line of JavaScript runs. The tabs need a script; the
 * findings do not.
 *
 * ON THE COPY
 * -----------
 * Every takeaway below is generated from the numbers rather than typed next to
 * them, so it cannot drift out of date when the next crawl lands. That
 * constrains the phrasing, deliberately. A sentence that would stop being true
 * at a different value is a sentence this file cannot write, which rules out
 * most of the ways a chart caption goes wrong.
 *
 * The register is the one the rest of the repository uses: say the number, say
 * what it is out of, stop. Seven headlines out of 59 is seven headlines out of
 * 59. It is not a trend, a shift, a wave, or the future of anything, and the
 * counts here are far too small to carry a word like "dominant".
 */

import { barChart, companyLink, detailsTable, escapeHtml, finding, shareBars, stackChart } from './charts.js';

/** The whole landing view, as HTML. */
export function renderPositioning(insights) {
  return [
    kpiRow(insights),
    headlineSection(insights.headline_words),
    categorySection(insights.category_nouns),
    aiSection(insights.ai_mentions),
    proofSection(insights.proof_claims),
    logoSection(insights.logo_mentions),
    pricingSection(insights.pricing),
    segmentSection(insights.segments),
  ].join('\n\n');
}

// ------------------------------------------------------------------ kpi row

function kpiRow({ headline_words: words, category_nouns: nouns, ai_mentions: ai, pricing }) {
  const platform = nouns.groups.find((g) => g.noun === 'platform');
  const topWord = words.words[0];

  const tiles = [
    {
      label: 'Companies read',
      value: words.coverage.tracked,
      sub: `${words.coverage.readable} with a readable hero headline`,
    },
    {
      label: 'Say AI or agents',
      value: ai.mentions.length,
      sub: `of ${ai.coverage.readable} readable, in headline, subhead or category`,
    },
    {
      label: 'Call themselves a platform',
      value: platform ? platform.n : 0,
      sub: `of ${nouns.coverage.readable} readable category labels`,
    },
    {
      label: `Headlines saying &ldquo;${escapeHtml(topWord?.word ?? '&mdash;')}&rdquo;`,
      value: topWord?.n ?? 0,
      sub: `of ${words.coverage.readable}, the most of any word`,
    },
  ];

  return '<dl class="kpis">\n' + tiles.map((t) =>
    `<div><dt>${t.label}</dt><dd>${t.value}</dd><p>${t.sub}</p></div>`
  ).join('\n') + '\n</dl>';
}

// --------------------------------------------------------------- 1 headlines

function headlineSection(words) {
  const [first, second] = words.words;
  const platform = words.words.find((w) => w.word === 'platform');

  // One sentence: the top word, its runner-up, and where the old default sits.
  const caption = first
    ? `The word most B2B SaaS homepages reach for is <b>&ldquo;${escapeHtml(first.word)}&rdquo;</b>, ` +
      `in ${first.n} of ${words.coverage.readable} hero headlines` +
      (second ? `, just ahead of &ldquo;${escapeHtml(second.word)}&rdquo; at ${second.n}` : '') +
      (platform && platform !== first ? `, with the old default &ldquo;platform&rdquo; on ${platform.n}` : '') +
      '.'
    : 'No hero headline is currently readable.';

  return finding({
    id: 'p-headlines',
    // The lead number: how many headlines open with the single commonest word.
    stat: first
      ? { figure: first.n, unit: `of ${words.coverage.readable} headlines lead with "${first.word}"` }
      : undefined,
    heading: 'What the headlines say',
    caption,
    chips: [
      { label: `${words.coverage.readable} of ${words.coverage.tracked} read`, tone: 'coverage' },
      { label: 'counted once per company', tone: 'measured' },
    ],
    chart: barChart({
      rows: words.words.map((w) => ({ label: w.word, n: w.n, note: `${w.n} of ${words.coverage.readable} headlines` })),
    }),
    method:
      'Counted once per company, not once per occurrence, so a headline that repeats a word still votes once. ' +
      'Words are lowercased and split on punctuation, nothing is stemmed &mdash; &ldquo;agent&rdquo; and &ldquo;agents&rdquo; are ' +
      'different claims &mdash; and the standard English stopword list is removed along with everything ' +
      `shorter than three letters. That last rule is what keeps &ldquo;AI&rdquo; out of this chart; it has its own ` +
      `section below. ${words.distinct_words} distinct words appear in total, the great majority of them once.`,
    inspect: detailsTable({
      summary: 'Show the headlines behind each word',
      columns: [
        { label: 'Word', get: (w) => `<b>${escapeHtml(w.word)}</b>` },
        { label: 'Companies', class: 'num', get: (w) => String(w.n) },
        {
          label: 'The headlines',
          get: (w) => '<ul class="quotes">' + w.companies.map((c) =>
            `<li>${companyLink(c)} &mdash; ${escapeHtml(c.text)}</li>`).join('') + '</ul>',
        },
      ],
      rows: words.words,
    }),
  });
}

// -------------------------------------------------------------- 2 categories

function categorySection(nouns) {
  const [first, second] = nouns.groups;

  // One sentence: the commonest self-description and how far it leads the next.
  const caption = first
    ? `Asked what they <i>are</i>, <b>${first.n} of ${nouns.coverage.readable}</b> companies still say ` +
      `<b>${escapeHtml(first.noun)}</b>` +
      (second
        ? `, nearly ${Math.floor(first.n / second.n)} times the next answer, &ldquo;${escapeHtml(second.noun)}&rdquo;, at ${second.n}` +
          (second.n < 10 ? ', and nothing else reaches double figures' : '')
        : '') +
      '.'
    : 'No category label is currently readable.';

  const rows = nouns.groups.map((g) => ({
    label: g.noun,
    n: g.n,
    note: `${g.n} of ${nouns.coverage.readable} category labels`,
  }));
  if (nouns.unmatched.length) {
    // Quiet, because this row measures the vocabulary rather than the market.
    rows.push({
      label: 'no noun we recognise',
      n: nouns.unmatched.length,
      tone: 'quiet',
      note: 'the label carries no noun in our vocabulary',
    });
  }

  return finding({
    id: 'p-categories',
    // The lead number: how many still reach for the commonest noun.
    stat: first
      ? { figure: first.n, unit: `of ${nouns.coverage.readable} category labels` }
      : undefined,
    heading: 'What they call themselves',
    caption,
    chips: [
      { label: `${nouns.coverage.readable} of ${nouns.coverage.tracked} read`, tone: 'coverage' },
      // This signal is a scored guess over a fixed vocabulary; the method says so at length.
      { label: 'lowest-confidence signal', tone: 'judged' },
    ],
    chart: barChart({ rows }),
    method:
      'The category label is the noun phrase a company uses for itself &mdash; &ldquo;the AI workspace&rdquo;, ' +
      '&ldquo;CRM for agentic revenue&rdquo;. Each label is grouped by the first noun in it that appears in a ' +
      'fixed vocabulary, read left to right, because English puts the head noun before its qualifiers: ' +
      '&ldquo;AI platform for marketers&rdquo; is a platform, not a marketer. Singular and plural are grouped ' +
      'together here, unlike in the headline count, because as a self-description they are the same claim. ' +
      'A label with no noun we know is not forced into a bucket &mdash; it is shown as it is. ' +
      'Extraction of this signal is a scored guess over a fixed vocabulary and is the least reliable of the twelve.',
    inspect: detailsTable({
      summary: 'Show every category label, grouped',
      columns: [
        { label: 'Noun', get: (g) => `<b>${escapeHtml(g.noun)}</b>` },
        { label: 'Companies', class: 'num', get: (g) => String(g.n) },
        {
          label: 'The labels',
          get: (g) => '<ul class="quotes">' + g.companies.map((c) =>
            `<li>${companyLink(c)} &mdash; ${escapeHtml(c.text)}</li>`).join('') + '</ul>',
        },
      ],
      rows: nouns.groups.concat(
        nouns.unmatched.length
          ? [{ noun: 'no noun we recognise', n: nouns.unmatched.length, companies: nouns.unmatched }]
          : []
      ),
    }),
  });
}

// ---------------------------------------------------------------------- 3 AI

const FIELD_LABELS = {
  headline: 'hero headline',
  subhead: 'hero subhead',
  category_label: 'category label',
};

function aiSection(ai) {
  const mentions = ai.mentions.length;
  const quiet = ai.quiet.length;
  const quietNames = ai.quiet.slice(0, 3).map((c) => c.name);

  // One sentence: the count, then the more valuable list -- who is not selling AI.
  const caption =
    `<b>${mentions} of ${ai.coverage.readable}</b> companies put AI, agent, copilot or autonomous language ` +
    `into the first three things a visitor reads &mdash; the ${quiet} that do not are the interesting list` +
    (quietNames.length ? `, and it includes ${escapeHtml(quietNames.join(', '))}` : '') +
    '.';

  const stack = stackChart({
    segments: [
      { label: 'use AI or agent language', n: mentions, tone: 'lead' },
      { label: 'do not', n: quiet, tone: 'quiet' },
      {
        label: 'not readable',
        n: ai.coverage.unreadable,
        tone: 'none',
        note: '(we could read none of the three fields)',
      },
    ],
  });

  const byTerm = barChart({
    rows: ai.by_term.map((t) => ({
      label: t.term === 'ai' ? 'AI' : t.term,
      n: t.n,
      note: `${t.n} of ${ai.coverage.readable} companies`,
    })),
  });

  const byField = barChart({
    rows: ai.by_field.map((f) => ({
      label: FIELD_LABELS[f.field] ?? f.field,
      n: f.n,
      note: `${f.n} of ${ai.coverage.readable} companies`,
    })),
  });

  return finding({
    id: 'p-ai',
    // The lead number: how many readable homepages sell AI up front.
    stat: { figure: mentions, unit: `of ${ai.coverage.readable} readable homepages sell AI` },
    heading: 'How many are selling AI',
    caption,
    chips: [
      { label: `${ai.coverage.readable} of ${ai.coverage.tracked} read`, tone: 'coverage' },
      { label: 'four term families, whole-word match', tone: 'measured' },
    ],
    // The split is the primary chart; the two breakdowns follow it.
    chart: stack,
    extra:
      `<div class="chart-pair">\n` +
      `<div><h4>Which word</h4>${byTerm}</div>\n` +
      `<div><h4>Where it appears</h4>${byField}</div>\n` +
      `</div>`,
    method:
      'A company counts if any of its hero headline, hero subhead or category label contains one of four ' +
      'term families, matched as whole words: <b>ai</b> (so &ldquo;AI-powered&rdquo; counts and &ldquo;said&rdquo; does not), ' +
      '<b>agent / agents / agentic</b>, <b>copilot</b>, <b>autonomous / autonomy</b>. ' +
      'The list is the definition &mdash; nothing is fuzzy-matched, and a company that sells AI without using ' +
      'any of these four words is counted as not using them, which is the honest limit of a word count. ' +
      'A company appears once no matter how many of the three fields mention it, so the two smaller charts ' +
      'below add up to more than the number above.',
    inspect: detailsTable({
      summary: `Show all ${mentions + quiet} companies and what they say`,
      columns: [
        { label: 'Company', get: (c) => companyLink(c) },
        { label: 'Uses AI language', get: (c) => (c.terms ? escapeHtml(c.terms.map((t) => (t === 'ai' ? 'AI' : t)).join(', ')) : '<span class="quiet">no</span>') },
        { label: 'Where', get: (c) => escapeHtml((c.fields ?? []).map((f) => FIELD_LABELS[f] ?? f).join(', ')) },
        { label: 'Headline', get: (c) => escapeHtml(c.text ?? '') },
      ],
      rows: ai.mentions.concat(ai.quiet).sort((a, b) => a.name.localeCompare(b.name, 'en')),
    }),
  });
}

// ----------------------------------------------------------- 4 proof points

function proofSection(proof) {
  const [first, second] = proof.kinds;
  const time = proof.kinds.find((k) => k.key === 'time');

  // One sentence: the commonest kind of proof, the runner-up, and the scarce one.
  const caption = first
    ? `When these companies prove something, they count things: ${first.n} of ${proof.coverage.readable} ` +
      `use a <b>${escapeHtml(first.label.toLowerCase())}</b> claim` +
      (second ? ` and ${second.n} use a ${escapeHtml(second.label.toLowerCase())} claim` : '') +
      (time ? `, and only ${time.n} promise a time to result, the claim buyers actually ask about` : '') +
      '.'
    : 'No proof points are currently readable.';

  return finding({
    id: 'p-proof',
    // The lead number: how many lean on the commonest kind of proof.
    stat: first
      ? { figure: first.n, unit: `of ${proof.coverage.readable} use a ${first.label.toLowerCase()} claim` }
      : undefined,
    heading: 'What they use as proof',
    caption,
    chips: [
      { label: `${proof.coverage.readable} of ${proof.coverage.tracked} read`, tone: 'coverage' },
      { label: 'counts companies, not claims', tone: 'measured' },
    ],
    chart: barChart({
      rows: proof.kinds.map((k) => ({
        label: k.label,
        n: k.n,
        note: `${k.n} companies, ${k.claims} claims`,
      })),
    }),
    method:
      `Bars count <b>companies</b>, not claims: a homepage with eleven percentage claims has one opinion ` +
      `about how to prove things, and counting claims would let one verbose page outvote ten others. ` +
      `${proof.total_claims} individual claims were read across ${proof.coverage.readable} companies, and a company ` +
      'appears in every category it uses, so the bars sum to more than that. ' +
      '&ldquo;40% faster&rdquo; and &ldquo;faster by 40%&rdquo; are one category, because the difference between them is ' +
      'a property of our regexes rather than of the market.',
    inspect: detailsTable({
      summary: 'Show the claims behind each category',
      columns: [
        { label: 'Category', get: (k) => `<b>${escapeHtml(k.label)}</b><br><span class="quiet">${escapeHtml(k.note)}</span>` },
        { label: 'Companies', class: 'num', get: (k) => String(k.n) },
        {
          label: 'The claims',
          get: (k) => '<ul class="quotes">' + k.companies.map((c) =>
            `<li>${companyLink(c)} &mdash; ${escapeHtml(c.text)}</li>`).join('') + '</ul>',
        },
      ],
      rows: proof.kinds,
    }),
  });
}

// ----------------------------------------------------------------- 5 logos

function logoSection(logos) {
  const [first, second] = logos.logos;

  // One sentence: the most-named customer, and the finding that none dominates.
  const caption = first
    ? `The customer named on the most homepages is <b>${escapeHtml(first.logo)}</b>, on ${first.n} of ` +
      `${logos.coverage.readable} readable logo walls` +
      (second ? `, then ${escapeHtml(second.logo)} on ${second.n}` : '') +
      `; with ${logos.distinct_logos} distinct names across ${logos.coverage.readable} walls and none above ` +
      `${first.n}, there is no logo the whole category leans on.`
    : 'No customer logos are currently readable.';

  return finding({
    id: 'p-logos',
    // The lead number: the most any single logo appears -- the point is how low it is.
    stat: first
      ? { figure: first.n, unit: `the most any one logo appears, across ${logos.coverage.readable} walls` }
      : undefined,
    heading: 'Whose logo is everyone using',
    caption,
    chips: [
      { label: `${logos.coverage.readable} of ${logos.coverage.tracked} read`, tone: 'coverage' },
      // The shallowest measurement on the page: these counts are a floor.
      { label: 'a floor, not a count', tone: 'note' },
    ],
    chart: barChart({
      rows: logos.logos.map((l) => ({
        label: l.logo,
        n: l.n,
        note: `cited by ${l.n} of ${logos.coverage.readable} companies`,
      })),
    }),
    method:
      'This is the shallowest measurement on the page and the numbers below are a floor, not a count. ' +
      'Logo names are read from image <code>alt</code> text, image filenames and inline SVG titles, so a wall ' +
      'built from CSS sprites or a single flat image reads as no logos at all &mdash; which is why 14 companies ' +
      'are missing rather than empty. Spellings are case-folded before counting, because the same customer is ' +
      '&ldquo;OpenAI&rdquo; on one page and &ldquo;Openai&rdquo; on the next; the spelling shown is the most common one.',
    inspect: detailsTable({
      summary: 'Show who cites each logo',
      columns: [
        { label: 'Logo', get: (l) => `<b>${escapeHtml(l.logo)}</b>` },
        { label: 'Cited by', class: 'num', get: (l) => String(l.n) },
        { label: 'On these homepages', get: (l) => l.companies.map(companyLink).join(', ') },
      ],
      rows: logos.logos,
    }),
  });
}

// ---------------------------------------------------------------- 6 pricing

function pricingSection(pricing) {
  const free = pricing.free_tier;
  const entry = pricing.entry_price;
  const readable = free.coverage.readable;

  // One sentence: of the pages we can read, how many publish a free tier.
  const caption =
    `Of the ${readable} pricing pages this crawler can read, <b>${free.yes.length} publish a free tier</b> and ` +
    `${free.no.length} do not.`;

  const freeStack = stackChart({
    segments: [
      { label: 'publish a free tier', n: free.yes.length, tone: 'lead' },
      { label: 'publish pricing, no free tier', n: free.no.length, tone: 'quiet' },
      {
        label: 'pricing not readable',
        n: free.coverage.unreadable,
        tone: 'none',
        note: '(not the same as having no free tier)',
      },
    ],
  });

  const currencies = entry.currencies.map((c) => `${c.n} in ${escapeHtml(c.currency)}`).join(', ');

  const buckets = barChart({
    rows: entry.buckets.map((b) => ({
      label: b.label,
      n: b.n,
      note: `${b.n} of ${entry.coverage.readable} readable entry prices`,
    })),
  });

  return finding({
    id: 'p-pricing',
    // The lead number: how many readable pricing pages publish a free tier.
    stat: { figure: free.yes.length, unit: `of ${readable} readable pricing pages publish a free tier` },
    heading: 'What the pricing pages show',
    caption,
    chips: [
      { label: `${free.coverage.readable} of ${free.coverage.tracked} read`, tone: 'coverage' },
      // A page we cannot read is not a company without a free plan.
      { label: 'unreadable is not "no free tier"', tone: 'note' },
    ],
    // The free-tier split leads; the entry-price buckets follow it.
    chart: freeStack,
    extra:
      `<h4 class="sub-chart-head">Cheapest published paid price, where we could read one ` +
      `(${entry.coverage.readable} companies)</h4>\n${buckets}`,
    method:
      `Two different denominators, kept apart because they are two different measurements: ${readable} pricing ` +
      `pages yield a readable tier list, and only ${entry.coverage.readable} of those also yield a number. ` +
      `${pricing.tiers.contact_sales.length} of the readable pages carry at least one tier with no price on it at all. ` +
      `Amounts are not currency-converted &mdash; ${currencies} &mdash; because a converted figure is a number no page ` +
      'ever published. The lowest bucket is real rather than a rounding artefact: a usage-priced product’s ' +
      'cheapest published number is a per-unit rate, not a seat price. ' +
      `The median of the ${entry.coverage.readable} readable entry prices is ${entry.median}, which describes these ` +
      'few numbers and is not a market price.',
    inspect:
      detailsTable({
        summary: `Show the ${entry.coverage.readable} readable entry prices`,
        columns: [
          { label: 'Company', get: (c) => companyLink(c) },
          { label: 'Entry price', class: 'mono', get: (c) => escapeHtml(c.text) },
          { label: 'Tier', get: (c) => escapeHtml(c.tier ?? '—') },
        ],
        rows: entry.companies,
      }) +
      detailsTable({
        summary: `Show the ${free.coverage.unreadable} companies whose pricing we cannot read`,
        columns: [
          { label: 'Company', get: (c) => companyLink(c) },
        ],
        rows: free.coverage.missing ?? [],
      }),
  });
}

// --------------------------------------------------------------- 7 segments

/**
 * The same questions, cut by what kind of company is asking them.
 *
 * Everything below is generated, including the decision about what to show. The
 * page does not carry a hand-written list of interesting cuts; it carries every
 * cut src/insights.js computes, and prints the ones that cleared the minimum
 * cell size and the fragility rule as charts and the ones that did not as a
 * list of reasons. If the next crawl makes a withheld cut reportable it appears
 * on its own, and if it makes a drawn one fragile it disappears on its own.
 *
 * That is the only arrangement that survives contact with cells of 6 to 16. A
 * human choosing which segment differences to show, after seeing them, is
 * choosing the finding.
 */
function segmentSection(seg) {
  const sizes = seg.groups.map((g) => g.n).sort((a, b) => a - b);
  const drawn = seg.cuts.filter((c) => c.drawn);
  const withheld = seg.cuts.filter((c) => !c.drawn);

  // The AI question is the one this section was built to answer, so it leads
  // when it survives the rules. When it does not, the section says so and the
  // next surviving cut leads instead -- rather than the page quietly reordering
  // itself around whatever came out best.
  const lead = drawn.find((c) => c.key === 'ai') ?? drawn[0] ?? null;
  const rest = drawn.filter((c) => c !== lead);

  // One sentence: the grouping, and the widest surviving gap (or that none survives).
  const caption = lead
    ? `Folded into <b>${seg.groups.length} groups</b> of ${sizes[0]} to ${sizes[sizes.length - 1]} companies, ` +
      `the segments do part company on ${lead.subject}: ` +
      `<b>${lead.top.yes} of ${lead.top.readable}</b> readable companies in ${escapeHtml(lead.top.label)}, ` +
      `against <b>${lead.bottom.yes} of ${lead.bottom.readable}</b> in ${escapeHtml(lead.bottom.label)}, a gap ${wide(lead.spread)}.`
    : `None of the ${seg.cuts.length} cuts computed here survives the minimum cell size and the fragility ` +
      'rule, so this section has no chart in it.';

  // The lead cut is the primary chart; the rest, the withheld list, and this
  // section's own coverage line (which has no counterpart in the shared method)
  // follow it. The chips carry the summary; this keeps the full denominators and
  // the ungrouped-company note on the page rather than dropping them.
  const extra = [
    rest.length
      ? '<h4 class="sub-chart-head">The other cuts that survived the rules</h4>\n' +
        `<div class="cut-grid">\n${rest.map((c) => cutBlock(c)).join('\n')}\n</div>`
      : '',
    withheldBlock(withheld, seg),
    segmentCoverage(seg),
  ].filter(Boolean).join('\n');

  return finding({
    id: 'p-segments',
    // The lead number: how many computed cuts survive the two rules. Holds at 0 too.
    stat: { figure: drawn.length, unit: `of ${seg.cuts.length} cuts survive the two rules` },
    heading: 'Whether the segment changes the story',
    caption,
    chips: [
      { label: `${seg.coverage.readable} of ${seg.coverage.tracked} grouped`, tone: 'coverage' },
      // Cells of six to sixteen, held to a minimum size and a fragility margin.
      { label: 'small cells, fragility-tested', tone: 'note' },
    ],
    chart: lead ? cutBlock(lead) : '',
    extra,
    method:
      `seed/companies.json labels every company with one of fourteen segments, and seven of those hold ` +
      `three companies or fewer &mdash; one holds a single company. A bar over one company invites a ` +
      'conclusion about a market from one homepage, so the fourteen are folded into ' +
      `${seg.groups.length} groups. A seed segment is never split: all of its companies move together, so the ` +
      'grouping can be disagreed with as a whole rather than audited company by company. The full mapping, ' +
      'with every company in it, opens below. ' +
      `Two rules then decide what is drawn. A cell computed over fewer than <b>${seg.min_cell_n}</b> ` +
      `companies is not drawn at all &mdash; at six, one company is 17 percentage points &mdash; and a cut where ` +
      `fewer than ${seg.min_groups_drawn} of the ${seg.groups.length} groups clear that floor is withheld entirely. ` +
      `A cut whose best and worst group are within <b>${seg.fragile_flips} companies</b> of each other is also ` +
      'withheld, because a reader looks at the bars and not at the caveat. ' +
      'Every bar states its own count and denominator, and no percentage on this page appears without them.',
    inspect: mappingTable(seg) + matrixTable(seg),
  });
}

/** One cut: its bars, and how many companies the spread is worth. */
function cutBlock(cut) {
  const rows = cut.ranked.concat(cut.cells.filter((c) => c.suppressed))
    .map((c) => ({
      label: c.short,
      part: c.yes,
      whole: c.readable,
      of: c.n,
      suppressed: c.suppressed,
    }));

  const notes = [
    `Top to bottom this spread is ${wide(cut.spread)}: that many companies in ${escapeHtml(cut.bottom.short)} ` +
    `changing one line would tie it with ${escapeHtml(cut.top.short)}.`,
  ];

  const k = cut.lead_over_runner_up;
  if (k === 0) {
    notes.push(`${escapeHtml(cut.top.short)} and ${escapeHtml(cut.runner_up.short)} are level at the top.`);
  } else if (k != null && k <= 2) {
    notes.push(
      `${wideCount(k)} would tie the top two, so the <i>order</i> of these bars is not a finding &mdash; ` +
      'only the distance between the ends is.'
    );
  }

  return '<div class="cut">\n' +
    `<h4>${escapeHtml(cut.label)}</h4>\n` +
    shareBars({ rows, unit: cut.denominator }) + '\n' +
    `<p class="cut-note">${notes.join(' ')}</p>\n` +
    '</div>';
}

/**
 * The cuts that were computed and not drawn, each with the rule that stopped it.
 *
 * This is the part of the section that took the most work and it is the part
 * worth reading. Three of the questions worth asking of this data cannot be
 * answered by it, and saying which three is a finding rather than a gap.
 */
function withheldBlock(withheld, seg) {
  if (!withheld.length) return '';

  const items = withheld.map((cut) => {
    const reasons = [];

    if (cut.withheld.rule === 'coverage') {
      const clear = cut.cells.filter((c) => !c.suppressed);
      reasons.push(
        `only ${cut.withheld.drawable} of the ${cut.withheld.groups} groups have ${seg.min_cell_n} or more ` +
        `${escapeHtml(cut.denominator)}` +
        (clear.length
          ? ` (${clear.map((c) => `${escapeHtml(c.short)} ${c.readable}`).join(', ')})`
          : '') +
        '.'
      );
      // A cut where nearly everybody answers the same way has nothing left for a
      // segment to explain even where the cells are big enough, and saying only
      // "coverage" would imply a better crawl would produce a finding.
      const share = cut.overall.readable ? cut.overall.yes / cut.overall.readable : 0;
      if (cut.overall.readable && (share >= 0.9 || share <= 0.1)) {
        reasons.push(
          `Across the whole set ${cut.overall.yes} of the ${cut.overall.readable} readable answers are the ` +
          'same, so there would be little for a segment to explain even at full coverage.'
        );
      }
    } else {
      reasons.push(
        `best group to worst is ${wide(cut.withheld.spread)}, inside the ${seg.fragile_flips}-company margin ` +
        'this page treats as no difference at all ' +
        `(${escapeHtml(cut.top.short)} ${cut.top.yes} of ${cut.top.readable}, ` +
        `${escapeHtml(cut.bottom.short)} ${cut.bottom.yes} of ${cut.bottom.readable}).`
      );
    }

    return `<li><b>${escapeHtml(cut.label)}</b> &mdash; ${reasons.join(' ')}</li>`;
  });

  return '<h4 class="sub-chart-head">Cuts we computed and did not draw</h4>\n' +
    `<ul class="withheld">\n${items.join('\n')}\n</ul>`;
}

/** The section's own coverage line: the grouping first, then every denominator. */
function segmentCoverage(seg) {
  const parts = [
    `Every <b>${seg.coverage.readable} of ${seg.coverage.tracked}</b> companies falls into exactly one group; ` +
    'none is dropped and none is counted twice.',
  ];

  if (seg.ungrouped.length) {
    parts.push(
      `${seg.ungrouped.length} carry a seed segment this mapping does not know and are missing from every ` +
      `bar above: ${seg.ungrouped.map((c) => escapeHtml(c.name)).join(', ')}.`
    );
  }

  // One line per distinct denominator rather than per cut: five of the nine cuts
  // share the proof-points denominator, and printing "52 of 60" five times
  // reads as five separate measurements.
  const denominators = new Map();
  for (const cut of seg.cuts) {
    const key = `${cut.overall.readable}|${cut.denominator}`;
    if (!denominators.has(key)) denominators.set(key, cut);
  }
  parts.push(
    'Each cut has its own denominator, and every bar prints it: ' +
    [...denominators.values()]
      .map((c) => `<b>${c.overall.readable} of ${c.overall.tracked}</b> ${escapeHtml(c.denominator)}`)
      .join('; ') +
    '. Not readable means we could not extract it, not that the company does not do it.'
  );

  parts.push(
    `A group cell computed over fewer than ${seg.min_cell_n} companies is drawn as &ldquo;too few to say&rdquo; ` +
    'with its own n, never as a short bar.'
  );

  return `<p class="coverage">${parts.join(' ')}</p>`;
}

/** Which seed segments went where, and which companies came with them. */
function mappingTable(seg) {
  return detailsTable({
    summary: `Show how the 14 seed segments fold into ${seg.groups.length} groups`,
    columns: [
      {
        label: 'Group',
        get: (g) => `<b>${escapeHtml(g.label)}</b><br><span class="quiet">${g.why}</span>`,
      },
      { label: 'Companies', class: 'num', get: (g) => String(g.n) },
      {
        label: 'Seed segments',
        get: (g) => '<ul class="quotes">' + g.segments.map((s) =>
          `<li><code>${escapeHtml(s.segment)}</code> &mdash; ${s.n}</li>`).join('') + '</ul>',
      },
      { label: 'The companies', get: (g) => g.companies.map(companyLink).join(', ') },
    ],
    rows: seg.groups,
  });
}

/** Every cut against every group, drawn or not, as the numbers behind it. */
function matrixTable(seg) {
  const groupColumns = seg.groups.map((g) => ({
    label: `${g.short} (${g.n})`,
    class: 'num',
    get: (cut) => {
      const c = cut.cells.find((x) => x.group === g.key);
      if (c.suppressed) {
        return `<span class="quiet">too few &mdash; ${c.readable} of ${c.n} readable</span>`;
      }
      return `<b>${c.yes} of ${c.readable}</b> <span class="quiet">${Math.round((c.yes / c.readable) * 100)}%</span>`;
    },
  }));

  return detailsTable({
    summary: `Show all ${seg.cuts.length} cuts by group, including the ${seg.withheld.length} not drawn`,
    columns: [
      { label: 'Cut', get: (cut) => `<b>${escapeHtml(cut.label)}</b>` },
      ...groupColumns,
      {
        label: 'Drawn',
        get: (cut) => (cut.drawn
          ? `yes &mdash; spread ${cut.spread}`
          : `<span class="quiet">no &mdash; ${cut.withheld.rule === 'coverage' ? 'coverage' : `spread ${cut.withheld.spread}`}</span>`),
      },
    ],
    rows: seg.cuts,
  });
}

/** "a gap 3 companies wide" -- the phrase the fragility rule exists to produce. */
function wide(n) {
  return `${wideCount(n)} wide`;
}

function wideCount(n) {
  return `<b>${n} ${n === 1 ? 'company' : 'companies'}</b>`;
}

