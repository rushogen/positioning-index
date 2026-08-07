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
