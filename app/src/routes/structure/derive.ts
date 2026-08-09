/**
 * View-model for the Structure tab. All numbers come straight from anatomy.json;
 * this module only reshapes them (typical position, a brand-spanning colour ramp
 * keyed to where a section usually sits, the archetype stack, the shape families).
 * It invents nothing — every share and count is the archive's own.
 */
import * as d3 from 'd3';
import type { Anatomy, Cluster } from '../../lib/types';
import { sectionLabel } from '../../lib/types';
import { dense, type Dropped } from '../../lib/filter';

export interface CompanyRef { slug: string; name: string }

export interface Band {
  type: string;
  label: string;
  n: number;          // pages that carry this section
  of: number;         // readable pages
  share: number;      // 0..100
  omits: number;      // of - n
  meanPos: number;    // typical slot on the page
  color: string;
  companies: CompanyRef[];
}

export interface SlotSeg { type: string; label: string; n: number; frac: number; color: string }
export interface Slot { position: number; n: number; segs: SlotSeg[]; restN: number; restFrac: number }

export interface FamilyView {
  id: number;
  size: number;
  name: string;
  sections: { type: string; label: string; color: string }[];
  members: CompanyRef[];
}

/** Weighted-mean slot each section type lands in, across the position columns. */
function typicalPositions(a: Anatomy): Map<string, number> {
  const num = new Map<string, number>();
  const den = new Map<string, number>();
  for (const col of a.positions.positions) {
    for (const t of col.types) {
      num.set(t.type, (num.get(t.type) ?? 0) + col.position * t.n);
      den.set(t.type, (den.get(t.type) ?? 0) + t.n);
    }
  }
  const out = new Map<string, number>();
  for (const [k, v] of num) out.set(k, v / (den.get(k) || 1));
  return out;
}

/**
 * A brand-spanning ramp: sections that sit high on the page read cool (indigo),
 * sections that sit low read warm (amber→pink). Hue therefore encodes position,
 * so the colour itself is a second signal, not decoration.
 */
const RAMP = d3.interpolateRgbBasis([
  '#7c9cff', '#5ec8d8', '#3ddca4', '#bcd15f', '#f5b74d', '#ff8f8a', '#ff7a9c',
]);

export function makeColor(a: Anatomy): (type: string) => string {
  const tp = typicalPositions(a);
  const vals = [...tp.values()];
  const s = d3.scaleLinear().domain([d3.min(vals) ?? 1, d3.max(vals) ?? 6]).range([0, 1]).clamp(true);
  return (type: string) => RAMP(s(tp.get(type) ?? 4));
}

export const accuracyPct = (a: Anatomy): number => Math.round(a.accuracy.nonHero * 100);

/**
 * The composite page: the hero (universal, so it leads) plus every section type
 * that clears the density bar, ordered by where it typically sits.
 */
export function buildArchetype(a: Anatomy): { of: number; bands: Band[]; dropped: Dropped<unknown> } {
  const of = a.elements.coverage.readable;
  const color = makeColor(a);
  const tp = typicalPositions(a);
  const d = dense(a.elements.elements, (e) => e.n, { top: 20 });

  const bands: Band[] = d.kept
    .map((e) => ({
      type: e.type,
      label: sectionLabel(a.labels, e.type),
      n: e.n,
      of,
      share: e.share ?? (e.n / (e.of || of)) * 100,
      omits: of - e.n,
      meanPos: tp.get(e.type) ?? 4,
      color: color(e.type),
      companies: e.companies,
    }))
    .sort((x, y) => x.meanPos - y.meanPos);

  const heroCol = a.positions.positions.find((p) => p.position === 1);
  const heroT = heroCol?.types.find((t) => t.type === 'hero');
  const hero: Band = {
    type: 'hero',
    label: sectionLabel(a.labels, 'hero'),
    n: heroT?.n ?? of,
    of,
    share: 100,
    omits: 0,
    meanPos: 1,
    color: color('hero'),
    companies: heroT?.companies ?? [],
  };

  return { of, bands: [hero, ...bands], dropped: d };
}

/** Type mix at the first few slots — slot 1 is the hero everywhere, then it splits. */
export function buildSlots(a: Anatomy, maxSlot = 5): Slot[] {
  const color = makeColor(a);
  return a.positions.positions
    .filter((p) => p.position <= maxSlot)
    .map((col) => {
      const d = dense(col.types, (t) => t.n, { min: 4, top: 8 });
      const segs: SlotSeg[] = d.kept.map((t) => ({
        type: t.type,
        label: sectionLabel(a.labels, t.type),
        n: t.n,
        frac: t.n / col.n,
        color: color(t.type),
      }));
      const restN = Math.max(0, col.n - segs.reduce((s, x) => s + x.n, 0));
      return { position: col.position, n: col.n, segs, restN, restFrac: restN / col.n };
    });
}

/** Characteristic sections become the family's name; an empty signature = hero-led. */
export function familyName(a: Anatomy, c: Cluster): string {
  if (!c.sections.length) return 'Hero-led, little else';
  return c.sections.map((s) => sectionLabel(a.labels, s)).join(' + ');
}

export function buildFamilies(a: Anatomy): FamilyView[] {
  const color = makeColor(a);
  return [...a.similarity.clusters.clusters]
    .sort((x, y) => y.size - x.size)
    .map((c) => ({
      id: c.id,
      size: c.size,
      name: familyName(a, c),
      sections: c.sections.map((s) => ({ type: s, label: sectionLabel(a.labels, s), color: color(s) })),
      members: c.members,
    }));
}
