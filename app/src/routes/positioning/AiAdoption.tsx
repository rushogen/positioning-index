/**
 * Finding 2 — how many put AI / agent / autonomous in the first three things you
 * read. A waffle where every cell is one real company (grouped adopters | quiet),
 * the by-term split, and — the interesting part — the named list of who does not.
 */
import { motion, useReducedMotion } from 'framer-motion';
import type { Positioning } from '../../lib/types';
import { Chip, Chips, Disclosure, Stat } from '../../components/ui';
import { Finding, CompanyList, NameCloud } from './parts';
import { pct } from './util';

export function AiAdoption({ data }: { data: Positioning['ai_mentions'] }) {
  const reduce = useReducedMotion();
  const of = data.coverage.readable;
  const said = data.mentions.length;
  const quiet = data.quiet.length;

  // One cell per readable company: adopters first, then the quiet block.
  const cells = [
    ...data.mentions.map((c) => ({ slug: c.slug, name: c.name, ai: true })),
    ...data.quiet.map((c) => ({ slug: c.slug, name: c.name, ai: false })),
  ];

  const termMax = Math.max(...data.by_term.map((t) => t.n), 1);

  return (
    <Finding n="02" kicker="The AI claim" title={<>Two in three sell AI on the way in</>}>
      <div className="lead">
        <Stat figure={said} unit={<>of {of} put AI, an agent, or “autonomous” in the first three things you read</>} />
        <div className="lead-copy">
          <p>
            Across the headline, subhead, and category label — the first three lines on the page —
            {' '}{said} of {of} companies name AI ({pct(said, of)}). The remaining {quiet} say nothing about it
            up top. The term is “AI” far more than “agent”; “autonomous” is still rare.
          </p>
          <Chips>
            <Chip tone="measured">measured</Chip>
            <Chip tone="coverage">{of} of {data.coverage.tracked} readable</Chip>
          </Chips>
        </div>
      </div>

      <div className="viz">
        <div className="waffle" role="img"
          aria-label={`${said} of ${of} companies mention AI; ${quiet} are quiet`}>
          {cells.map((c, i) => (
            <motion.span
              key={c.slug}
              className={`wf-cell ${c.ai ? 'wf-ai' : 'wf-quiet'}`}
              title={`${c.name} — ${c.ai ? 'mentions AI' : 'quiet'}`}
              initial={reduce ? false : { opacity: 0, scale: 0.4 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.25, delay: reduce ? 0 : Math.min(i * 0.004, 0.6) }}
            />
          ))}
        </div>
        <div className="wf-legend">
          <span className="wf-key"><i className="wf-swatch wf-ai" />{said} name AI up top</span>
          <span className="wf-key"><i className="wf-swatch wf-quiet" />{quiet} stay quiet</span>
        </div>
      </div>

      <div className="term-bars">
        <p className="term-head">Which term, of {of} readable pages</p>
        {data.by_term.map((t) => (
          <div key={t.term} className="term-row">
            <span className="term-label">{t.term}</span>
            <span className="term-track">
              <motion.span className="term-fill"
                initial={reduce ? false : { scaleX: 0 }}
                whileInView={{ scaleX: 1 }} viewport={{ once: true }}
                transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                style={{ width: `${(t.n / termMax) * 100}%` }} />
            </span>
            <span className="term-n num">{t.n}</span>
          </div>
        ))}
        <p className="drop-note">A page can use more than one term, so these do not sum to {said}.</p>
      </div>

      <div className="picked">
        <p className="picked-head">The {quiet} that say nothing about AI up top</p>
        <NameCloud companies={data.quiet} />
      </div>

      <Disclosure summary={`The ${said} that do — with the terms found`}>
        <CompanyList companies={data.mentions} showText />
      </Disclosure>
    </Finding>
  );
}
