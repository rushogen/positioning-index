import * as d3 from 'd3';
import type { Anatomy } from '../../lib/types';
import { Card, Chip, Chips, Stat } from '../../components/ui';
import { buildSlots, accuracyPct, type Slot } from './derive';

const W = 720;
const ROW_H = 46;
const GAP = 14;
const LEFT = 66;
const PAD_R = 10;

export function Slots({ a }: { a: Anatomy }) {
  const slots = buildSlots(a, 5);
  const acc = accuracyPct(a);

  const barX = LEFT;
  const barW = W - LEFT - PAD_R;
  const x = d3.scaleLinear().domain([0, 1]).range([0, barW]);
  const height = slots.length * ROW_H + (slots.length - 1) * GAP;

  // Legend: the union of types shown, kept in position order via first appearance.
  const seen = new Map<string, string>();
  for (const s of slots) for (const seg of s.segs) if (!seen.has(seg.type)) seen.set(seg.type, seg.color);
  const legend = [...seen.entries()].map(([type, color]) => ({
    type, color, label: s0Label(slots, type),
  }));

  return (
    <div>
      <div className="st-lead">
        <Stat figure="1" tone="ink" unit="slot is identical everywhere — the hero. Then it forks." />
        <div className="st-lead-copy">
          <p className="lede">
            Slot 1 is a hero on all {slots[0]?.n ?? 0} pages. By slot 2 the market has already split — a feature grid
            leads for some, a logo wall or a security block for others — and each slot down fragments further. This is
            where structural choice actually happens.
          </p>
          <Chips>
            <Chip tone="judged">judged · classifier ~{acc}% off the hero</Chip>
            <Chip tone="measured">slot 1 = hero, measured</Chip>
          </Chips>
        </div>
      </div>

      <Card style={{ marginTop: '1.6rem' }}>
        <div className="slot-scroll">
          <svg className="slot-svg" viewBox={`0 0 ${W} ${height}`} role="img"
            aria-label="Section type mix at the first five slots on the page">
            {slots.map((slot, i) => {
              const y = i * (ROW_H + GAP);
              let acc0 = 0;
              return (
                <g key={slot.position}>
                  <text x={LEFT - 12} y={y + ROW_H / 2} textAnchor="end" dominantBaseline="middle"
                    fontSize={18} style={{ fill: 'var(--ink-2)', fontFamily: 'var(--serif)' }}>{slot.position}</text>
                  <text x={LEFT - 12} y={y + ROW_H / 2 + 15} textAnchor="end" dominantBaseline="middle"
                    fontSize={9} style={{ fill: 'var(--ink-3)' }}>n={slot.n}</text>
                  {slot.segs.map((seg) => {
                    const sx = barX + x(acc0);
                    const sw = x(seg.frac);
                    acc0 += seg.frac;
                    const wide = sw > 42;
                    return (
                      <g key={seg.type}>
                        <rect x={sx} y={y} width={Math.max(0, sw - 1.5)} height={ROW_H} rx={4}
                          fill={seg.color} opacity={0.92}>
                          <title>{`Slot ${slot.position}: ${seg.label} — ${seg.n} of ${slot.n} (${Math.round(seg.frac * 100)}%)`}</title>
                        </rect>
                        {wide && (
                          <text x={sx + 7} y={y + ROW_H / 2} dominantBaseline="middle"
                            fontSize={11} fill="#0a0c11" fontWeight={500}>
                            {Math.round(seg.frac * 100)}%
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {slot.restFrac > 0.001 && (
                    <rect x={barX + x(acc0)} y={y} width={Math.max(0, x(slot.restFrac))} height={ROW_H} rx={4}
                      opacity={0.7} style={{ fill: 'var(--rule)' }}>
                      <title>{`Slot ${slot.position}: ${slot.restN} across smaller/other section types`}</title>
                    </rect>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
        <div className="slot-legend">
          {legend.map((l) => (
            <span key={l.type}><i className="fam-swatch" style={{ background: l.color }} />{l.label}</span>
          ))}
          <span><i className="fam-swatch" style={{ background: 'var(--rule)' }} />smaller / other</span>
        </div>
      </Card>
    </div>
  );
}

function s0Label(slots: Slot[], type: string): string {
  for (const s of slots) {
    const seg = s.segs.find((x) => x.type === type);
    if (seg) return seg.label;
  }
  return type;
}
