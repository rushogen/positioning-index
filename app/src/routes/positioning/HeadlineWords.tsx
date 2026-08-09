/**
 * Finding 1 — the words companies lead with. A ranked bar built bespoke (no
 * chart lib): each bar is a button; selecting one shows the companies behind it
 * with the exact headline read off the page.
 */
import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { Positioning } from '../../lib/types';
import { Chip, Chips, Disclosure, Stat } from '../../components/ui';
import { dense, droppedNote } from '../../lib/filter';
import { Finding, CompanyList } from './parts';

export function HeadlineWords({ data }: { data: Positioning['headline_words'] }) {
  const reduce = useReducedMotion();
  const of = data.coverage.readable;
  const d = dense(data.words, (w) => w.n);
  const words = d.kept;
  const max = words[0]?.n ?? 1;
  const top = words[0];
  const [sel, setSel] = useState(top?.word ?? '');
  const selected = words.find((w) => w.word === sel) ?? top;

  return (
    <Finding n="01" kicker="What they lead with" title={<>The word in the headline</>}>
      <div className="lead">
        <Stat figure={top?.n ?? '—'} unit={<>of {of} readable headlines lead with &ldquo;{top?.word}&rdquo;</>} />
        <div className="lead-copy">
          <p>
            Read the first line on {of} homepages and one word recurs more than any other. No word is
            on more than {top ? Math.round((top.n / of) * 100) : 0}% of pages, though — the vocabulary
            is a long tail, not a consensus.
          </p>
          <Chips>
            <Chip tone="measured">measured</Chip>
            <Chip tone="coverage">{of} of {data.coverage.tracked} readable</Chip>
            <Chip tone="note">{data.distinct_words} distinct leading words</Chip>
          </Chips>
        </div>
      </div>

      <div className="viz hbars" role="list">
        {words.map((w, i) => {
          const on = w.word === selected?.word;
          return (
            <button
              key={w.word}
              type="button"
              role="listitem"
              className={`hbar ${on ? 'hbar-on' : ''}`}
              aria-pressed={on}
              onClick={() => setSel(w.word)}
            >
              <span className="hbar-label">{w.word}</span>
              <span className="hbar-track">
                <motion.span
                  className="hbar-fill"
                  initial={reduce ? false : { scaleX: 0 }}
                  whileInView={{ scaleX: 1 }}
                  viewport={{ once: true, margin: '-40px' }}
                  transition={{ duration: 0.7, delay: reduce ? 0 : i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                  style={{ width: `${(w.n / max) * 100}%` }}
                />
              </span>
              <span className="hbar-n num">{w.n}</span>
            </button>
          );
        })}
      </div>

      {droppedNote(d) && <p className="drop-note">Showing the top {words.length}. Every other leading word is used by fewer than 4 companies.</p>}

      {selected && (
        <div className="picked">
          <p className="picked-head">
            <b className="num">{selected.n}</b> companies lead with &ldquo;{selected.word}&rdquo;
          </p>
          <CompanyList companies={selected.companies} showText />
        </div>
      )}

      <Disclosure summary="All twelve words and the companies behind each">
        {words.map((w) => (
          <div key={w.word} className="disc-group">
            <p className="disc-group-head"><b>{w.word}</b> · {w.n}</p>
            <CompanyList companies={w.companies} />
          </div>
        ))}
      </Disclosure>
    </Finding>
  );
}
