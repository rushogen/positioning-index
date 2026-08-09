/**
 * Market Composition — who the 200 companies in the index actually are.
 *
 * One D3 treemap over the corpus, re-cut live by the dimension you pick:
 *   · Company size (target_size: smb → mid-market → enterprise → broad)
 *   · Audience     (b2b / b2b2c / b2c)
 *   · Segment      (~30 product segments, long tail and all)
 *
 * Area encodes count; colour reads by dimension (an ordered accent ramp for the
 * ordered size bands, a shade-by-count ramp for the many segments). Every cell is
 * a button: click it to pin the group and reveal the companies inside, or open
 * the full disclosure for every group at once.
 *
 * Honesty: audience, target_size and segment are RESEARCH-JUDGED, not read off the
 * page — marked with a judged chip and a caveat. Company names are DATA: rendered
 * as React text only, never as markup.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import * as d3 from 'd3';
import type { CompanyFact } from '../../lib/types';
import { useFacts } from '../../lib/data';
import { Card, Caveat, Chip, Chips, Disclosure, ErrorNote, Loading, Reveal, Stat } from '../../components/ui';
import './market-composition.css';

type Dim = 'target_size' | 'audience' | 'segment';

interface Group {
  key: string;
  label: string;
  n: number;
  color: string;
  companies: CompanyFact[];
}

/** Treemap node shape: a root with group children; leaves carry the group. */
interface TMNode {
  key: string;
  n: number;
  color: string;
  children?: TMNode[];
  group?: Group;
}

const DIMS: { key: Dim; tab: string }[] = [
  { key: 'target_size', tab: 'Company size' },
  { key: 'audience', tab: 'Audience' },
  { key: 'segment', tab: 'Segment' },
];

const SIZE_LABEL: Record<string, string> = {
  smb: 'SMB', 'mid-market': 'Mid-market', enterprise: 'Enterprise', broad: 'Broad',
};
/** Ordered accent ramp: intensity climbs smb → enterprise; broad reads as its own (green) band. */
const SIZE_COLOR: Record<string, string> = {
  smb: 'color-mix(in srgb, var(--accent) 40%, var(--panel))',
  'mid-market': 'color-mix(in srgb, var(--accent) 66%, var(--panel))',
  enterprise: 'var(--accent)',
  broad: 'color-mix(in srgb, var(--accent-2) 60%, var(--panel))',
};
const SIZE_ORDER = ['smb', 'mid-market', 'enterprise', 'broad'];

const AUD_LABEL: Record<string, string> = { b2b: 'B2B', b2b2c: 'B2B2C', b2c: 'B2C' };
const AUD_COLOR: Record<string, string> = {
  b2b: 'var(--accent)', b2b2c: 'var(--accent-2)', b2c: 'var(--hot)',
};

const UNCLASSIFIED = 'var(--rule)';
const SEG_ACRONYMS = new Set(['grc', 'erp', 'hr', 'gtm', 'itsm', 'ccaas', 'clm', 'bpm', 'it', 'ai']);

function prettySegment(slug: string): string {
  return slug
    .split('-')
    .map((w) => (SEG_ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Bucket the companies for the chosen dimension into coloured, labelled groups. */
function buildGroups(companies: CompanyFact[], dim: Dim): Group[] {
  const by = new Map<string, CompanyFact[]>();
  for (const c of companies) {
    const raw = c[dim];
    const key = raw == null || raw === '' ? '__none' : String(raw);
    (by.get(key) ?? by.set(key, []).get(key)!).push(c);
  }

  if (dim === 'target_size') {
    const groups: Group[] = [];
    for (const k of SIZE_ORDER) {
      const list = by.get(k);
      if (list && list.length) {
        groups.push({ key: k, label: SIZE_LABEL[k] ?? k, n: list.length, color: SIZE_COLOR[k], companies: list });
      }
    }
    const none = by.get('__none');
    if (none?.length) groups.push({ key: '__none', label: 'Unclassified', n: none.length, color: UNCLASSIFIED, companies: none });
    return groups;
  }

  if (dim === 'audience') {
    return [...by.entries()]
      .map(([k, list]) => ({
        key: k,
        label: k === '__none' ? 'Unclassified' : (AUD_LABEL[k] ?? k),
        n: list.length,
        color: k === '__none' ? UNCLASSIFIED : (AUD_COLOR[k] ?? 'var(--accent)'),
        companies: list,
      }))
      .sort((a, b) => b.n - a.n);
  }

  // segment — many groups; shade by count so bigger reads stronger.
  const entries = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  const counts = entries.filter(([k]) => k !== '__none').map(([, l]) => l.length);
  const min = counts.length ? Math.min(...counts) : 0;
  const max = counts.length ? Math.max(...counts) : 1;
  return entries.map(([k, list]) => {
    if (k === '__none') return { key: k, label: 'Unclassified', n: list.length, color: UNCLASSIFIED, companies: list };
    const t = max > min ? (list.length - min) / (max - min) : 1;
    const p = Math.round(38 + t * 50); // 38% → 88% accent over panel
    return { key: k, label: prettySegment(k), n: list.length, color: `color-mix(in srgb, var(--accent) ${p}%, var(--panel))`, companies: list };
  });
}

/** A short, dimension-specific headline stat + caption. */
function headline(dim: Dim, groups: Group[], total: number): { figure: number; unit: string } {
  const sorted = [...groups].sort((a, b) => b.n - a.n);
  const top = sorted[0];
  if (dim === 'target_size') {
    return { figure: top?.n ?? 0, unit: `of ${total} sell primarily to ${top?.label ?? '—'} — the largest of four size bands` };
  }
  if (dim === 'audience') {
    const b2b = groups.find((g) => g.key === 'b2b')?.n ?? 0;
    const b2b2c = groups.find((g) => g.key === 'b2b2c')?.n ?? 0;
    return { figure: b2b, unit: `of ${total} sell to businesses (B2B); ${b2b2c} also reach end-users (B2B2C)` };
  }
  return { figure: groups.length, unit: `distinct segments across ${total} companies — the largest is ${top?.label ?? '—'} (${top?.n ?? 0})` };
}

export function MarketComposition() {
  const { data, error } = useFacts();
  const reduce = useReducedMotion();
  const [dim, setDim] = useState<Dim>('target_size');
  const [sel, setSel] = useState<string | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Depend on `data`: the box only mounts once facts have loaded (the component
  // shows <Loading/> until then), so an []-deps effect would attach the observer
  // to a ref that is still null and never re-run -> width stuck at 0, no tiles.
  // Seed the width synchronously too, so a first paint doesn't wait for the RO.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const companies = data?.companies ?? null;
  const total = companies?.length ?? 0;

  const groups = useMemo(() => (companies ? buildGroups(companies, dim) : []), [companies, dim]);

  const height = width > 0
    ? (width < 560 ? Math.round(width * 1.1) : Math.round(Math.min(Math.max(width * 0.52, 320), 540)))
    : 0;

  // D3 treemap: area = count. Recomputed on group set / box size change.
  const leaves = useMemo(() => {
    if (!groups.length || width <= 0 || height <= 0) return [];
    const rootData: TMNode = { key: '__root', n: 0, color: '', children: groups.map((g) => ({ key: g.key, n: g.n, color: g.color, group: g })) };
    const root = d3
      .hierarchy<TMNode>(rootData, (d) => d.children)
      .sum((d) => (d.children ? 0 : d.n))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const layout = d3.treemap<TMNode>().size([width, height]).paddingInner(3).round(true);
    return layout(root).leaves();
  }, [groups, width, height]);

  if (error) return <ErrorNote>Could not load facts: {error}</ErrorNote>;
  if (!data || !companies) return <Loading />;

  const activeKey = groups.some((g) => g.key === sel) ? sel : (groups[0]?.key ?? null);
  const active = groups.find((g) => g.key === activeKey) ?? null;
  const sorted = [...groups].sort((a, b) => b.n - a.n);
  const stat = headline(dim, groups, total);

  return (
    <Reveal className="mc">
      <header className="mc-head">
        <p className="kicker">Who&rsquo;s in the index</p>
        <h2 className="mc-title">The whole index, cut three ways</h2>
        <p className="mc-dek">
          All {total} companies, re-composed by who they are. Each rectangle is a group; its
          area is how many companies fall in it. Switch the lens, then click any block to see who&rsquo;s inside.
        </p>
      </header>

      <div className="mc-switch" role="tablist" aria-label="Composition dimension">
        {DIMS.map((d) => (
          <button
            key={d.key}
            type="button"
            role="tab"
            aria-selected={dim === d.key}
            className={`mc-tab ${dim === d.key ? 'mc-tab-on' : ''}`}
            onClick={() => setDim(d.key)}
          >
            {d.tab}
          </button>
        ))}
      </div>

      <div className="mc-lead">
        <Stat figure={stat.figure} unit={stat.unit} />
        <div className="mc-lead-side">
          <p className="mc-counts">
            {sorted.map((g, i) => (
              <span key={g.key}>
                {i > 0 && <span className="mc-dot"> · </span>}
                <span className="mc-count-label">{g.label}</span> <b className="num">{g.n}</b>
              </span>
            ))}
          </p>
          <Chips>
            <Chip tone="judged">judged classification</Chip>
            <Chip tone="coverage">{total} of {total} companies</Chip>
            {dim === 'target_size' && <Chip tone="note">colour ramps SMB → enterprise</Chip>}
          </Chips>
        </div>
      </div>

      <Card className="mc-card">
        <div className="mc-tm" ref={boxRef} style={{ height: height || undefined }}
          role="img"
          aria-label={`Treemap of ${total} companies by ${dim.replace('_', ' ')}`}>
          {leaves.map((leaf, i) => {
            const g = leaf.data.group;
            if (!g) return null;
            const w = leaf.x1 - leaf.x0;
            const h = leaf.y1 - leaf.y0;
            const showLabel = w > 62 && h > 30;
            const showN = !showLabel && w > 30 && h > 20;
            const on = g.key === activeKey;
            return (
              <motion.button
                key={`${dim}-${g.key}`}
                type="button"
                className={`mc-cell ${on ? 'mc-cell-on' : ''}`}
                title={`${g.label} — ${g.n} of ${total}`}
                aria-label={`${g.label}, ${g.n} of ${total} companies`}
                onClick={() => setSel(g.key)}
                style={{
                  left: leaf.x0, top: leaf.y0, width: w, height: h,
                  background: g.color,
                }}
                initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.35, delay: reduce ? 0 : Math.min(i * 0.012, 0.5), ease: [0.22, 1, 0.36, 1] }}
              >
                {showLabel && (
                  <span className="mc-cell-label">
                    <span className="mc-cell-name">{g.label}</span>
                    <span className="mc-cell-n num">{g.n}</span>
                  </span>
                )}
                {showN && <span className="mc-cell-mini num">{g.n}</span>}
              </motion.button>
            );
          })}
        </div>
      </Card>

      {active && (
        <div className="mc-picked">
          <p className="mc-picked-head">
            <b className="num">{active.n}</b> {active.n === 1 ? 'company is' : 'companies are'}{' '}
            <span className="mc-picked-key">{active.label}</span>
            <span className="mc-picked-hint"> — click another block to switch</span>
          </p>
          <CompanyGrid companies={active.companies} />
        </div>
      )}

      <Caveat>
        Company size, audience and segment are <b>research-judged</b> — a considered read of each
        company, not a label lifted off the page — so treat them as a careful classification, not ground truth.
        Every one of the {total} companies is classified on each lens.
      </Caveat>

      <Disclosure summary="Every group and the companies inside it">
        {sorted.map((g) => (
          <div key={g.key} className="mc-disc-group">
            <p className="mc-disc-head"><b>{g.label}</b> · {g.n}</p>
            <CompanyGrid companies={g.companies} />
          </div>
        ))}
      </Disclosure>
    </Reveal>
  );
}

/** Company names as a dense grid. Names are DATA — React text, never markup. */
function CompanyGrid({ companies }: { companies: CompanyFact[] }) {
  const list = [...companies].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <ul className="mc-colist">
      {list.map((c) => (
        <li key={c.slug} className="mc-co">{c.name}</li>
      ))}
    </ul>
  );
}
