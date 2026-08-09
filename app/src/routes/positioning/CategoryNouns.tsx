/**
 * Finding 3 — what companies call themselves (the category noun). The point is
 * concentration: one noun carries a huge share and the rest is a long tail. Shown
 * as a single 100%-stacked vocabulary bar plus a ranked list. Lowest-confidence
 * signal on the tab — it leans on a judged read, so it is marked as such.
 */
import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { Positioning } from '../../lib/types';
import { Chip, Chips, Disclosure, Stat } from '../../components/ui';
import { dense } from '../../lib/filter';
import { Finding, CompanyList } from './parts';
import { pct } from './util';

export function CategoryNouns({ data }: { data: Positioning['category_nouns'] }) {
  const reduce = useReducedMotion();
  const of = data.coverage.readable;
  const d = dense(data.groups, (g) => g.n);
  const kept = d.kept;
  const top = kept[0];
  const two = (kept[0]?.n ?? 0) + (kept[1]?.n ?? 0);
  const keptSum = kept.reduce((s, g) => s + g.n, 0);
  const tail = of - keptSum; // dropped small nouns + unmatched pages
  const [sel, setSel] = useState(top?.noun ?? '');
  const selected = kept.find((g) => g.noun === sel) ?? top;

  return (
    <Finding n="03" kicker="What they call themselves" title={<>Almost everyone is a “platform”</>}>
      <div className="lead">
        <Stat tone="ink" figure={top?.n ?? '—'} unit={<>of {of} call themselves a “{top?.noun}” — {pct(top?.n ?? 0, of)} of the readable pages</>} />
        <div className="lead-copy">
          <p>
            The category vocabulary is narrow: the two most common nouns —
            “{kept[0]?.noun}” and “{kept[1]?.noun}” — account for {two} of {of} pages ({pct(two, of)}).
            Everything else is scattered across dozens of one-off labels.
          </p>
          <Chips>
            <Chip tone="judged">judged</Chip>
            <Chip tone="coverage">{of} of {data.coverage.tracked} readable</Chip>
            <Chip tone="note">lowest-confidence signal on this tab</Chip>
          </Chips>
        </div>
      </div>

      <div className="viz">
        <div className="conc-bar" role="img" aria-label={`Category nouns across ${of} pages`}>
          {kept.map((g, i) => (
            <motion.button
              key={g.noun}
              type="button"
              className={`conc-seg ${g.noun === selected?.noun ? 'conc-on' : ''}`}
              title={`${g.noun} — ${g.n}`}
              aria-label={`${g.noun}, ${g.n} of ${of}`}
              onClick={() => setSel(g.noun)}
              style={{ flexGrow: g.n }}
              initial={reduce ? false : { opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: reduce ? 0 : i * 0.05 }}
            >
              {g.n / of > 0.08 && <span className="conc-seg-label">{g.noun}</span>}
            </motion.button>
          ))}
          {tail > 0 && (
            <span className="conc-seg conc-tail" style={{ flexGrow: tail }} title={`long tail — ${tail}`} aria-label={`long tail, ${tail}`} />
          )}
        </div>
        <div className="conc-scale">
          <span>0</span><span>{of} pages</span>
        </div>
      </div>

      {selected && (
        <div className="picked">
          <p className="picked-head"><b className="num">{selected.n}</b> call themselves a “{selected.noun}”</p>
          <CompanyList companies={selected.companies} />
        </div>
      )}

      <p className="drop-note">
        The grey tail is {tail} pages: {d.droppedCompanies} across {d.droppedRows} nouns each under 4,
        plus {data.unmatched.length} whose noun did not match a known category word.
      </p>

      <Disclosure summary="Every ranked noun and its companies">
        {kept.map((g) => (
          <div key={g.noun} className="disc-group">
            <p className="disc-group-head"><b>{g.noun}</b> · {g.n}</p>
            <CompanyList companies={g.companies} />
          </div>
        ))}
      </Disclosure>
    </Finding>
  );
}
