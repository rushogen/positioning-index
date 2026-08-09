import { motion, useReducedMotion } from 'framer-motion';
import * as d3 from 'd3';
import type { Anatomy } from '../../lib/types';
import { Card, Chip, Chips, Disclosure, Stat } from '../../components/ui';
import { droppedNote } from '../../lib/filter';
import { buildArchetype, accuracyPct, type Band } from './derive';

function ArchRow({ band, widthPct, delay, reduce }: { band: Band; widthPct: number; delay: number; reduce: boolean }) {
  return (
    <div className="arch-row">
      <div className="arch-label">
        {band.label}
        {band.omits > 0 && <span className="arch-omit">{band.omits} omit</span>}
      </div>
      <div className="arch-track" title={`${band.label}: ${band.n} of ${band.of} pages (${Math.round(band.share)}%)`}>
        <motion.div
          className="arch-fill"
          style={{ background: band.color, width: `${widthPct}%` }}
          initial={reduce ? false : { width: '0%', opacity: 0.4 }}
          whileInView={reduce ? undefined : { width: `${widthPct}%`, opacity: 1 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="arch-fill-sheen" />
        </motion.div>
      </div>
      <div className="arch-pct">{Math.round(band.share)}<span>%</span></div>
    </div>
  );
}

export function Archetype({ a }: { a: Anatomy }) {
  const reduce = !!useReducedMotion();
  const { of, bands, dropped } = buildArchetype(a);
  const acc = accuracyPct(a);
  const note = droppedNote(dropped, 'section types');

  // Silhouette: band width tracks prevalence, from a readable floor up to full.
  const w = d3.scaleLinear().domain([0, 100]).range([16, 100]);

  return (
    <div>
      <div className="st-lead">
        <Stat figure={of} unit="readable pages composited into one" />
        <div className="st-lead-copy">
          <p className="lede">
            Stack every readable homepage and the average shows through: a hero on all of them, a feature grid on
            four in five, then proof, social and security thinning as you scroll. Width is how universal a band is;
            hue tracks how far down the page it usually falls.
          </p>
          <Chips>
            <Chip tone="judged">judged · classifier ~{acc}% off the hero</Chip>
            <Chip tone="measured">hero is position 1 on every page</Chip>
          </Chips>
        </div>
      </div>

      <Card className="arch-frame" style={{ marginTop: '1.6rem' }}>
        <div className="arch-bar" aria-hidden>
          <span className="arch-dot" /><span className="arch-dot" /><span className="arch-dot" />
          <span className="arch-bar-title">the-archetype-homepage · {of} pages</span>
        </div>
        <div className="arch-stack">
          {bands.map((b, i) => (
            <ArchRow key={b.type} band={b} widthPct={w(b.share)} delay={reduce ? 0 : i * 0.04} reduce={reduce} />
          ))}
        </div>
      </Card>

      {note && <div style={{ marginTop: '0.9rem' }}><Chips><Chip tone="note">{note}</Chip></Chips></div>}

      <Disclosure summary="Who carries each section">
        {bands.filter((b) => b.companies.length).map((b) => (
          <p className="st-disc-group" key={b.type}>
            <b>{b.label}</b> · {b.n}/{b.of}{' '}
            <span className="st-disc-names">{b.companies.map((c) => c.name).join(', ')}</span>
          </p>
        ))}
      </Disclosure>
    </div>
  );
}
