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
