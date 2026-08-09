/**
 * Cross-cuts — does a positioning signal move with who a company is? Pick a
 * SIGNAL (measured off the page) and a GROUPING (research-judged), and read each
 * group's rate as a horizontal bar labelled `yes of readable`. crossCut() does
 * the honesty: nulls (unreadable) never count as "no", and a cell under MIN_CELL
 * is drawn as a count only — never a rate a handful of companies pretend to hold.
 */
import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { CompanyFact } from '../../lib/types';
import { crossCut, MIN_CELL } from '../../lib/filter';
import { useFacts } from '../../lib/data';
import { Chip, Chips, Disclosure, ErrorNote, Loading, Stat } from '../../components/ui';

type SignalKey = 'ai' | 'free_tier';
type DimKey = 'target_size' | 'audience' | 'segment';

const SIGNALS: Record<SignalKey, {
  label: string; noun: string; verb: string;
  tone: 'accent' | 'green'; fill: string;
  fn: (c: CompanyFact) => boolean | null;
}> = {
  ai: {
    label: 'Sells AI',
    noun: 'sell AI up top',
    verb: 'name AI, an agent, or “autonomous” in the first lines',
    tone: 'accent',
    fill: 'cc-fill-ai',
    fn: (c) => c.ai,
  },
  free_tier: {
    label: 'Publishes a free tier',
    noun: 'publish a free tier',
    verb: 'state a free tier on the pricing page',
    tone: 'green',
    fill: 'cc-fill-ft',
    fn: (c) => (c.free_tier === 'yes' ? true : c.free_tier === 'no' ? false : null),
  },
};

const DIMS: Record<DimKey, { label: string; blurb: string; fn: (c: CompanyFact) => string | null }> = {
  target_size: { label: 'Company size', blurb: 'who they sell to, by account size', fn: (c) => c.target_size },
  audience: { label: 'Audience', blurb: 'the go-to-market motion', fn: (c) => c.audience },
  segment: { label: 'Segment', blurb: 'the product category cluster', fn: (c) => c.segment },
};

// Human labels for the raw group keys. Anything unlisted is title-cased.
const GROUP_LABELS: Record<string, string> = {
  smb: 'SMB', 'mid-market': 'Mid-market', enterprise: 'Enterprise', broad: 'Broad',
  b2b: 'B2B', b2b2c: 'B2B2C', b2c: 'B2C',
  gtm: 'GTM', ccaas: 'CCaaS', grc: 'GRC', erp: 'ERP', itsm: 'ITSM', bpm: 'BPM',
  'hr-ops': 'HR ops', 'clm-esign': 'CLM & e-sign', 'healthcare-it': 'Healthcare IT',
  'banking-tech': 'Banking tech', 'fintech-ops': 'Fintech ops', 'legal-tech': 'Legal tech',
  'dev-infra': 'Dev infra', 'process-mining': 'Process mining', 'product-dev': 'Product dev',
  'work-mgmt': 'Work mgmt',
};
const prettyGroup = (g: string): string =>
  GROUP_LABELS[g] ?? g.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

const pct = (n: number, of: number): string => (of ? `${Math.round((n / of) * 100)}%` : '—');

export function CrossCuts() {
  const { data, error } = useFacts();
  const [signalKey, setSignalKey] = useState<SignalKey>('ai');
  const [dimKey, setDimKey] = useState<DimKey>('target_size');

  const signal = SIGNALS[signalKey];
  const dim = DIMS[dimKey];
  const reduce = useReducedMotion();

  const companies = data?.companies ?? [];
  const cells = useMemo(
    () => crossCut(companies, dim.fn, signal.fn),
    [companies, dim, signal],
  );

  // Coverage of this cut: rows where BOTH the grouping and the signal are readable.
  const readableTotal = cells.reduce((s, c) => s + c.readable, 0);
  const tracked = companies.length;

  const rated = cells.filter((c) => !c.suppressed);
  const top = rated[0];
  const bottom = rated.length > 1 ? rated[rated.length - 1] : undefined;
  const spread = top && bottom ? Math.round((top.rate - bottom.rate) * 100) : 0;
  const firstSuppressed = cells.findIndex((c) => c.suppressed);

  // For the "who's in the yes set" disclosure, resolve names per group.
  const yesNames = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of companies) {
      const g = dim.fn(c);
      if (g == null) continue;
      if (signal.fn(c) === true) m.set(g, [...(m.get(g) ?? []), c.name]);
    }
    return m;
  }, [companies, dim, signal]);

  return (
    <section className="cc" aria-labelledby="cc-title">
      <header className="cc-head">
        <p className="kicker">The cross-cut</p>
        <h2 id="cc-title" className="cc-title">Does the signal move with the segment?</h2>
        <p className="cc-dek">
          Pick a signal read off the page, then a way to group the index. Each bar is that
          group’s rate — <b>yes of readable</b> — never a share an unreadable page was folded into.
        </p>
      </header>

      {/* controls */}
      <div className="cc-controls">
        <div className="cc-control">
          <span className="cc-control-label">Signal</span>
          <div className="cc-seg" role="group" aria-label="Choose a signal">
            {(Object.keys(SIGNALS) as SignalKey[]).map((k) => (
              <button
                key={k}
                type="button"
                className={`cc-pill ${k === signalKey ? 'cc-pill-on' : ''}`}
                aria-pressed={k === signalKey}
                onClick={() => setSignalKey(k)}
              >
                {SIGNALS[k].label}
              </button>
            ))}
          </div>
        </div>
        <div className="cc-control">
          <span className="cc-control-label">Grouped by</span>
          <div className="cc-seg" role="group" aria-label="Choose a grouping">
            {(Object.keys(DIMS) as DimKey[]).map((k) => (
              <button
                key={k}
                type="button"
                className={`cc-pill ${k === dimKey ? 'cc-pill-on' : ''}`}
                aria-pressed={k === dimKey}
                onClick={() => setDimKey(k)}
              >
                {DIMS[k].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Chips>
        <Chip tone="measured">{signal.label} is measured</Chip>
        <Chip tone="judged">grouping is judged, not measured</Chip>
        <Chip tone="coverage">{readableTotal} of {tracked} readable</Chip>
      </Chips>

      {error ? (
        <ErrorNote>Could not load facts: {error}</ErrorNote>
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {/* dynamic lead, derived from the cut itself */}
          {top && (
            <div className="cc-lead">
              <Stat
                tone={signal.tone}
                figure={pct(top.yes, top.readable)}
                unit={<><b>{prettyGroup(top.group)}</b> leads — {top.yes} of {top.readable} {signal.noun}</>}
              />
              <div className="cc-lead-copy">
                <p>
                  Grouped by {dim.blurb}, {prettyGroup(top.group)} shows the highest rate that
                  {' '}{tracked} companies can support{bottom && (
                    <> — {spread} points above {prettyGroup(bottom.group)} at {pct(bottom.yes, bottom.readable)}
                    {' '}({bottom.yes} of {bottom.readable})</>
                  )}. A page whose signal or grouping can’t be read is dropped from that cell,
                  never scored as a “no”.
                </p>
              </div>
            </div>
          )}

          {/* rate bars */}
          <div className="cc-bars">
            {cells.map((cell, i) => {
              const names = yesNames.get(cell.group) ?? [];
              return (
                <div key={cell.group}>
                  {i === firstSuppressed && firstSuppressed > 0 && (
                    <p className="cc-divider">
                      Too few to rate — under {MIN_CELL} readable answers, shown as a count only
                    </p>
                  )}
                  <div className={`cc-row ${cell.suppressed ? 'cc-row-supp' : ''}`}>
                    <span className="cc-row-label" title={cell.group}>{prettyGroup(cell.group)}</span>
                    {cell.suppressed ? (
                      <span className="cc-toofew">
                        too few — {cell.yes} of {cell.readable}
                      </span>
                    ) : (
                      <>
                        <span
                          className="cc-track"
                          role="img"
                          aria-label={`${prettyGroup(cell.group)}: ${cell.yes} of ${cell.readable} ${signal.noun}, ${pct(cell.yes, cell.readable)}`}
                        >
                          <motion.span
                            className={`cc-fill ${signal.fill}`}
                            initial={reduce ? false : { scaleX: 0 }}
                            whileInView={{ scaleX: 1 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.6, delay: reduce ? 0 : Math.min(i * 0.04, 0.4), ease: [0.22, 1, 0.36, 1] }}
                            style={{ width: `${cell.rate * 100}%` }}
                          />
                        </span>
                        <span className="cc-val num">
                          <b className={`tone-${signal.tone}`}>{pct(cell.yes, cell.readable)}</b>
                          <span className="cc-val-of">{cell.yes} of {cell.readable}</span>
                        </span>
                      </>
                    )}
                  </div>
                  {names.length > 0 && (
                    <Disclosure summary={`The ${names.length} in ${prettyGroup(cell.group)} that ${signal.noun}`}>
                      <ul className="cc-names">
                        {names.map((n) => <li key={n}>{n}</li>)}
                      </ul>
                    </Disclosure>
                  )}
                </div>
              );
            })}
          </div>

          <p className="caveat">
            {signal.label} is read off the page — {signal.verb}; an unreadable page is
            {' '}<b>null</b>, excluded from the denominator, never counted as a “no”. The grouping
            ({dim.label.toLowerCase()}) is research-judged, not measured, so these splits are the least
            certain reading here. Bars are ordered by rate; cells under {MIN_CELL} readable answers show
            their count without a rate.
          </p>
        </>
      )}
    </section>
  );
}
