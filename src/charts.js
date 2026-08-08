/**
 * Charts, as inline SVG, rendered at build time.
 *
 * WHY THE SVG HAS NO viewBox
 * --------------------------
 * The obvious way to make an SVG responsive is a `viewBox` plus `width: 100%`,
 * and it is wrong for a chart with text in it. A viewBox scales the whole
 * coordinate system, so a chart authored at 640 units wide renders at half
 * scale on a 320px phone and its 12px labels come out at 6px.
 *
 * So these charts have no viewBox at all. The SVG is `width="100%"` with a
 * height in real pixels, which makes one SVG user unit exactly one CSS pixel at
 * every viewport width. Bar lengths are expressed as *percentages*, which SVG
 * resolves against the element's own width, and everything that must not
 * stretch -- corner radii, the gaps between stacked segments, the bar height --
 * stays in pixels. Nothing scales, nothing distorts, and there is no breakpoint
 * to get wrong.
 *
 * The consequence is that the label and the value cannot live inside the SVG,
 * because their widths are unknown at build time. They are real HTML text in a
 * CSS grid beside the plot, which is better anyway: they reflow, they wrap,
 * they respond to browser zoom and to a reader's minimum font size, and they
 * are selectable and searchable. The SVG carries the mark and nothing else, and
 * is `aria-hidden` because every number it encodes is already in the text next
 * to it.
 *
 * NO JAVASCRIPT
 * -------------
 * All of this is a string produced by `npm run build` and written into
 * docs/index.html. With scripting disabled the charts, their numbers, their
 * coverage notes and the tables of companies behind them all still render --
 * the disclosure is a `<details>` element, not a click handler.
 *
 * NO THIRD PARTIES
 * ----------------
 * No chart library, no sprite sheet, no icon font, no remote image. Same reason
 * as everything else here: TDDDG section 25 makes a request to someone else's
 * server a consent problem, and the simplest way to need no consent dialogue is
 * to need no third party. See the header of bin/build-site.js.
 *
 * COLOUR
 * ------
 * Three tones, and they are an emphasis palette rather than a categorical one:
 * `lead` is the site's existing accent and carries the thing being measured,
 * `quiet` is a neutral for the companies that are the other side of the same
 * count, and `none` is a lighter neutral reserved for "we could not read this".
 * They are defined once in public/style.css against the existing theme
 * variables, so light and dark are handled there and there is no second
 * palette. Every value is also printed as text, which is what licenses the
 * deliberately recessive contrast of the `none` tone.
 *
 * The share bars added for the segment breakdown introduce no fourth tone. They
 * are one series, so they are `lead`, and the 100% rail behind them is drawn in
 * the existing `--rule` -- chrome, the same substance as a grid line, carrying
 * no value of its own.
 */

/** Text that came off someone's marketing page is data, never markup. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Percentages are rounded to two decimals so the output is byte-stable. A float
 * printed at full precision would be identical run to run anyway, but two
 * decimals is finer than a pixel at any width and reads better in the source.
 */
function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 10000) / 100;
}

const BAR_HEIGHT = 14;
const BAR_ROW_HEIGHT = 18;
const STACK_HEIGHT = 30;

/**
 * A ranked horizontal bar chart.
 *
 * One series, so one colour for every bar and no legend -- the heading says
 * what is plotted. The bars are scaled against the largest value rather than
 * against the coverage total, because the question these charts answer is
 * "which of these is bigger", and every one of them prints its own count in
 * text beside the bar.
 *
 * A row may opt into the `quiet` tone. That is reserved for a row which is not
 * one of the things being counted -- the labels our vocabulary failed to match,
 * for instance. It is a measurement of us, sitting in a chart about them, and
 * painting it the same colour as the real answers would quietly promote it into
 * one.
 *
 * @param {object} args
 * @param {{label: string, n: number, note?: string, tone?: 'lead'|'quiet'}[]} args.rows  already sorted by the caller
 * @param {string} args.unit  what one count means, for the row title attribute
 */
export function barChart({ rows, unit = 'companies' }) {
  const max = rows.reduce((m, r) => Math.max(m, r.n), 0);

  const items = rows.map((row) => {
    const width = pct(row.n, max);
    const tone = row.tone === 'quiet' ? ' quiet' : '';
    const marks = row.n > 0
      ? `<rect class="bar-fill${tone}" x="0" y="${(BAR_ROW_HEIGHT - BAR_HEIGHT) / 2}" width="${width}%" height="${BAR_HEIGHT}" rx="4"></rect>` +
        // Squares off the end sitting on the baseline, so the bar grows out of
        // the axis rather than floating as a pill. Skipped on a bar too short
        // to contain it, where it would stick out past its own fill.
        (width >= 3 ? `<rect class="bar-fill${tone}" x="0" y="${(BAR_ROW_HEIGHT - BAR_HEIGHT) / 2}" width="4" height="${BAR_HEIGHT}"></rect>` : '')
      : '';

    return `<li class="bar-row"${row.note ? ` title="${escapeHtml(row.note)}"` : ''}>` +
      `<span class="bar-label">${escapeHtml(row.label)}</span>` +
      `<svg class="bar-track" width="100%" height="${BAR_ROW_HEIGHT}" aria-hidden="true" focusable="false">${marks}</svg>` +
      `<span class="bar-value">${row.n}</span>` +
      '</li>';
  });

  return `<ol class="bars-svg" aria-label="${escapeHtml(`ranked by number of ${unit}`)}">\n${items.join('\n')}\n</ol>`;
}

/**
 * A share bar: what fraction of each group answers yes, on a fixed 0-100% axis.
 *
 * WHY THIS IS NOT `barChart`
 * --------------------------
 * `barChart` scales every bar against the largest count, which is right for
 * "which of these words is used most" and wrong for "which of these groups says
 * this most often". The groups have different sizes, so 13 of 15 and 6 of 6 are
 * not comparable as counts at all. This chart plots the rate, and the track is
 * the whole denominator: a bar that fills the rail is every readable company in
 * that group. The rail is drawn rather than implied, because a percentage
 * without a visible 100% is a bar whose length means nothing.
 *
 * One series, so one colour and no legend. The rail is chrome in the existing
 * `--rule` tone, not a second data colour.
 *
 * WHAT EVERY ROW MUST CARRY
 * -------------------------
 * The count and its denominator, as text, in the row -- not in a `title`, not
 * in a footnote under the chart. `4 of 6 &middot; 67%` is a claim a reader can
 * size immediately; `67%` is one they cannot, and on cells this small the
 * difference between the two is the whole argument. The percentage never
 * appears without the counts that produced it, which is why they are one string
 * built in one place here rather than two fields a caller could use separately.
 *
 * A row below the minimum denominator is passed in with `suppressed` and draws
 * no mark at all. It still occupies a row and still states its n, because a
 * group that silently vanishes from a chart reads as a group that scored zero.
 *
 * @param {object} args
 * @param {{label: string, part: number, whole: number, of: number,
 *          suppressed?: boolean}[]} args.rows  already sorted by the caller
 * @param {string} args.unit  what the denominator counts, for the list label
 */
export function shareBars({ rows, unit = 'companies' }) {
  const items = rows.map((row) => {
    if (row.suppressed) {
      return `<li class="bar-row share-row muted">` +
        `<span class="bar-label">${escapeHtml(row.label)}</span>` +
        `<span class="share-suppressed">too few to say &mdash; ${row.whole} of ${row.of} readable</span>` +
        `<span class="bar-value">&mdash;</span>` +
        '</li>';
    }

    const width = pct(row.part, row.whole);
    const marks =
      `<rect class="share-rail" x="0" y="${(BAR_ROW_HEIGHT - BAR_HEIGHT) / 2}" width="100%" height="${BAR_HEIGHT}" rx="4"></rect>` +
      (row.part > 0
        ? `<rect class="bar-fill" x="0" y="${(BAR_ROW_HEIGHT - BAR_HEIGHT) / 2}" width="${width}%" height="${BAR_HEIGHT}" rx="4"></rect>` +
          // Same squared-off baseline end as barChart, so the mark grows out of
          // the axis instead of floating as a pill.
          (width >= 3 ? `<rect class="bar-fill" x="0" y="${(BAR_ROW_HEIGHT - BAR_HEIGHT) / 2}" width="4" height="${BAR_HEIGHT}"></rect>` : '')
        : '');

    return `<li class="bar-row share-row">` +
      `<span class="bar-label">${escapeHtml(row.label)}</span>` +
      `<svg class="bar-track" width="100%" height="${BAR_ROW_HEIGHT}" aria-hidden="true" focusable="false">${marks}</svg>` +
      // The geometry keeps two decimals so the output is byte-stable; the text
      // beside it is rounded to whole points, because 55.56% is a precision
      // nine companies cannot support and reads as though it could.
      `<span class="bar-value"><b>${row.part} of ${row.whole}</b> <span class="share-pct">${Math.round((row.part / row.whole) * 100)}%</span></span>` +
      '</li>';
  });

  return `<ol class="bars-svg" aria-label="${escapeHtml(`share of each group, out of ${unit}`)}">\n${items.join('\n')}\n</ol>`;
}

/**
 * A part-to-whole bar: one row, several segments, drawn once.
 *
 * Each segment is drawn from its own start all the way to the right edge, so
 * the segment after it paints over the excess. That is what leaves exactly two
 * rounded corners on the whole bar -- the outer two -- instead of a rounded
 * corner at every internal boundary. The 2px separators are painted last, in
 * the surface colour, because a gap in the surface is how touching marks are
 * separated here; nothing gets a border drawn round it.
 *
 * A legend is always rendered, because there is more than one segment and
 * colour must never be the only way to tell them apart. Every segment's count
 * appears in the legend as text.
 *
 * @param {{label: string, n: number, tone: 'lead'|'quiet'|'none', note?: string}[]} segments
 */
export function stackChart({ segments }) {
  const total = segments.reduce((sum, s) => sum + s.n, 0);
  const shown = segments.filter((s) => s.n > 0);

  const fills = [];
  const gaps = [];
  let offset = 0;
  for (const segment of shown) {
    const start = pct(offset, total);
    fills.push(
      `<rect class="seg ${segment.tone}" x="${start}%" y="0" width="${100 - start}%" height="${STACK_HEIGHT}" rx="4"></rect>`
    );
    if (offset > 0) {
      gaps.push(`<rect class="seg-gap" x="${start}%" y="0" width="2" height="${STACK_HEIGHT}" transform="translate(-1,0)"></rect>`);
    }
    offset += segment.n;
  }

  const legend = segments.map((segment) =>
    `<li><span class="swatch ${segment.tone}" aria-hidden="true"></span>` +
    `<b>${segment.n}</b> ${escapeHtml(segment.label)}` +
    (segment.note ? ` <span class="legend-note">${escapeHtml(segment.note)}</span>` : '') +
    '</li>'
  );

  return (
    `<svg class="stack" width="100%" height="${STACK_HEIGHT}" aria-hidden="true" focusable="false">\n` +
    `${fills.join('\n')}\n${gaps.join('\n')}\n</svg>\n` +
    `<ul class="chart-legend">\n${legend.join('\n')}\n</ul>`
  );
}

/**
 * The table view behind a chart, collapsed.
 *
 * Every chart on the page has one. It is what makes the recessive "not
 * readable" tone legitimate rather than a colour nobody can resolve, it is the
 * accessible equivalent of the mark, and it is the thing that turns a bar into
 * a claim someone can check: the companies are named, with the exact string
 * that put each of them in the bucket.
 *
 * `<details>` rather than a script, so it works with JavaScript switched off.
 */
export function detailsTable({ summary, columns, rows, open = false }) {
  if (!rows.length) return '';
  const head = columns.map((c) => `<th scope="col">${escapeHtml(c.label)}</th>`).join('');
  const body = rows.map((row) =>
    '<tr>' + columns.map((c) => {
      const cell = c.get(row);
      return `<td data-label="${escapeHtml(c.label)}"${c.class ? ` class="${c.class}"` : ''}>${cell}</td>`;
    }).join('') + '</tr>'
  ).join('\n');

  return `<details class="inspect"${open ? ' open' : ''}>\n` +
    `<summary>${escapeHtml(summary)}</summary>\n` +
    `<table class="grid"><thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody></table>\n</details>`;
}

/**
 * A finding, rendered stat-first.
 *
 * THE SHAPE, AND WHY
 * ------------------
 * This is the page's unit of argument, and it is built so the number is read
 * before the sentence and the sentence before the chart. A big figure and its
 * denominator lead; one caption states the finding in a single line; the caveats
 * that used to be a paragraph of coverage prose are compressed into chips a
 * reader can size at a glance. The chart follows. The full method and the table
 * of companies behind every mark stay exactly where they were -- collapsed in
 * <details> -- because compressing the *display* of the honesty must not delete
 * the honesty. Everything here still renders with no JavaScript.
 *
 * @param {object} a
 * @param {string} a.id  section id / scroll anchor
 * @param {{figure:string|number, unit?:string}} [a.stat]  the lead number and its denominator
 * @param {string} a.heading
 * @param {string} [a.caption]  ONE sentence; trusted HTML (built from the numbers, may carry <b>)
 * @param {{label:string, tone?:'measured'|'judged'|'coverage'|'note'}[]} [a.chips]
 * @param {string} [a.chart]  the visualisation, HTML
 * @param {string} [a.extra]  anything between the chart and the method (secondary charts, etc.)
 * @param {string} [a.method] the "how this is measured" prose, collapsed
 * @param {string} [a.inspect] the detailsTable(s) of companies behind the marks
 */
export function finding({ id, stat, heading, caption, chips = [], chart = '', extra = '', method = '', inspect = '' }) {
  return `<section class="finding" id="${escapeHtml(id)}">
<div class="finding-head">
${stat ? statBlock(stat) : ''}
<div class="finding-title">
<h3>${escapeHtml(heading)}</h3>
${caption ? `<p class="finding-cap">${caption}</p>` : ''}
${chips.length ? chipRow(chips) : ''}
</div>
</div>
${chart ? `<div class="finding-viz">\n${chart}\n</div>` : ''}
${extra}
${method ? `<details class="method"><summary>How this is measured</summary><p>${method}</p></details>` : ''}
${inspect}
</section>`;
}

/**
 * The lead number of a finding: a large figure and the denominator that keeps it
 * honest. `unit` is where "of 59 headlines" goes -- the figure never appears
 * without what it is out of, the same rule the coverage line enforced in prose.
 */
export function statBlock({ figure, unit = '' }) {
  return `<p class="stat"><b class="stat-fig">${escapeHtml(String(figure))}</b>` +
    (unit ? `<span class="stat-unit">${escapeHtml(unit)}</span>` : '') + '</p>';
}

/**
 * Caveats as chips instead of a paragraph.
 *
 * `measured` is a value read straight off the page; `judged` rests on the
 * classifier and so carries its ~49% accuracy with it; `coverage` is the
 * denominator; `note` is anything else. The tone is a label a reader can size at
 * a glance, and the full account is still one <details> away.
 */
export function chipRow(chips) {
  const items = chips
    .filter(Boolean)
    .map((c) => `<li class="chip chip-${escapeHtml(c.tone || 'note')}">${escapeHtml(c.label)}</li>`)
    .join('');
  return `<ul class="chips">${items}</ul>`;
}

/** A link to a company's page on this site. */
export function companyLink(entry) {
  return `<a href="#/company/${escapeHtml(entry.slug)}">${escapeHtml(entry.name)}</a>`;
}

/**
 * The coverage line that sits under every chart.
 *
 * Not optional and not a footnote: a count of 32 with no denominator is the
 * exact failure this project exists to avoid. `held` and `suspect` are spelled
 * out when they are non-zero, because "52 companies" and "52, one of which we
 * could not read this morning" are different claims.
 */
export function coverageNote(coverage, { unit = 'companies', reason = null } = {}) {
  const parts = [
    `Counted over <b>${coverage.readable} of ${coverage.tracked}</b> ${escapeHtml(unit)}.`,
  ];

  if (coverage.unreadable > 0) {
    parts.push(
      `${coverage.unreadable} not readable${reason ? ` &mdash; ${escapeHtml(reason)}` : ''}. ` +
      'Not readable means we could not extract it, not that the company does not publish it.'
    );
  }
  if (coverage.held > 0) {
    parts.push(
      `${coverage.held} of the counted values did not extract on the most recent read and is the last value we saw.`
    );
  }
  if (coverage.suspect > 0) {
    parts.push(
      `${coverage.suspect} is flagged as a suspected extraction failure, with change detection paused.`
    );
  }

  return `<p class="coverage">${parts.join(' ')}</p>`;
}
