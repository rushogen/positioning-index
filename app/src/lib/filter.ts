/**
 * Drop the low-n noise. For an audience of one who wants signal, a bar of two
 * companies or a category nobody uses is clutter, not a finding. These helpers
 * apply a consistent density bar across every chart so the decision is made in
 * one place and stated, not scattered per-view.
 *
 * The rule everywhere: keep a row only if it clears MIN_N, then keep at most
 * TOP_N of them. Whatever is dropped is counted, so a view can say "+14 smaller"
 * rather than silently truncating -- silence would read as "this is all there is".
 */

export const MIN_N = 4;   // a row needs at least this many companies to be drawn
export const TOP_N = 12;  // and we draw at most this many, ranked

export interface Dropped<T> {
  kept: T[];
  droppedRows: number;      // rows below MIN_N or past TOP_N
  droppedCompanies: number; // companies those rows accounted for
}

/**
 * Keep rows that clear `min`, ranked by count, capped at `top`. Report what fell
 * off so the caller can label it honestly.
 */
export function dense<T>(
  rows: T[],
  count: (row: T) => number,
  { min = MIN_N, top = TOP_N }: { min?: number; top?: number } = {},
): Dropped<T> {
  const ranked = [...rows].sort((a, b) => count(b) - count(a));
  const cleared = ranked.filter((r) => count(r) >= min);
  const kept = cleared.slice(0, top);
  const dropped = ranked.filter((r) => !kept.includes(r));
  return {
    kept,
    droppedRows: dropped.length,
    droppedCompanies: dropped.reduce((s, r) => s + count(r), 0),
  };
}

/** A short honest note for what `dense` dropped, or null if it dropped nothing. */
export function droppedNote(d: Dropped<unknown>, unit = 'smaller'): string | null {
  if (!d.droppedRows) return null;
  return `+${d.droppedRows} ${unit}, each under ${MIN_N}`;
}

// ---- cross-cuts -----------------------------------------------------------

export const MIN_CELL = 6; // a group cell needs this many readable answers to be trusted

export interface GroupCell {
  group: string;
  yes: number;
  readable: number; // yes + no (nulls excluded)
  rate: number;     // yes / readable, 0 if readable === 0
  suppressed: boolean; // readable < MIN_CELL — draw its n but not a rate
}

/**
 * Rate of a yes/no/null signal within each group of a dimension. Nulls (a value
 * that could not be read) are excluded from the denominator, never counted as
 * "no". A cell below MIN_CELL is flagged `suppressed` so the view can show its n
 * without drawing a rate a handful of companies cannot support. Sorted by rate,
 * suppressed cells last.
 */
export function crossCut<T>(
  rows: T[],
  group: (row: T) => string | null | undefined,
  answer: (row: T) => boolean | null | undefined,
  { minCell = MIN_CELL }: { minCell?: number } = {},
): GroupCell[] {
  const cells = new Map<string, { yes: number; readable: number }>();
  for (const row of rows) {
    const g = group(row);
    if (g == null) continue;
    const a = answer(row);
    if (a == null) continue;
    const cell = cells.get(g) ?? { yes: 0, readable: 0 };
    cell.readable += 1;
    if (a) cell.yes += 1;
    cells.set(g, cell);
  }
  return [...cells.entries()]
    .map(([g, { yes, readable }]) => ({
      group: g,
      yes,
      readable,
      rate: readable ? yes / readable : 0,
      suppressed: readable < minCell,
    }))
    .sort((a, b) => Number(a.suppressed) - Number(b.suppressed) || b.rate - a.rate);
}
