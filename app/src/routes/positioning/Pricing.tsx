/**
 * Finding 5 — price. The honest lead is legibility: most pricing pages can't be
 * read as a public number. Among the few that can, a free-tier split (kept
 * separate from "unreadable") and the entry-price distribution with its median.
 */
import { motion, useReducedMotion } from 'framer-motion';
import type { Positioning } from '../../lib/types';
import { Chip, Chips, Disclosure, Stat } from '../../components/ui';
import { Finding, CompanyList } from './parts';
import { pct } from './util';

export function Pricing({ data }: { data: Positioning['pricing'] }) {
  const reduce = useReducedMotion();
  const ft = data.free_tier;
  const tracked = ft.coverage.tracked;
  const yes = ft.yes.length;
  const no = ft.no.length;
  const readable = yes + no;
  const unreadable = tracked - readable;
  const contact = data.tiers.contact_sales.length;

  const ep = data.entry_price;
  const bMax = Math.max(...ep.buckets.map((b) => b.n), 1);

  const split = [
    { key: 'yes', label: `${yes} show a free tier`, n: yes, cls: 'seg-yes' },
    { key: 'no', label: `${no} show none`, n: no, cls: 'seg-no' },
    { key: 'un', label: `${unreadable} unreadable`, n: unreadable, cls: 'seg-un' },
  ];

  return (
    <Finding n="05" kicker="The price" title={<>Most pricing pages don’t show a price</>}>
      <div className="lead">
        <Stat tone="hot" figure={unreadable} unit={<>of {tracked} pricing pages could not be read as a public number — gated, contact-sales, or script-rendered</>} />
        <div className="lead-copy">
          <p>
            Only {readable} of {tracked} pages ({pct(readable, tracked)}) stated a free tier either way, and just
            {' '}{ep.coverage.readable} showed a numeric entry price. {contact} route the first tier to
            “contact sales.” An unreadable page is counted as unread — never as “no free tier.”
          </p>
          <Chips>
            <Chip tone="measured">measured</Chip>
            <Chip tone="coverage">{readable} of {tracked} readable on free tier</Chip>
          </Chips>
        </div>
      </div>

      <div className="viz grid grid-2">
        <div className="sub-card">
          <p className="sub-head">Free tier, across all {tracked} pages</p>
          <div className="split-bar" role="img" aria-label={`${yes} free tier, ${no} none, ${unreadable} unreadable, of ${tracked}`}>
            {split.map((s, i) => s.n > 0 && (
              <motion.span key={s.key} className={`split-seg ${s.cls}`} title={s.label}
                style={{ flexGrow: s.n }}
                initial={reduce ? false : { opacity: 0 }} whileInView={{ opacity: 1 }}
                viewport={{ once: true }} transition={{ duration: 0.4, delay: reduce ? 0 : i * 0.08 }}>
                {s.n / tracked > 0.06 && <span className="split-n num">{s.n}</span>}
              </motion.span>
            ))}
          </div>
          <div className="split-legend">
            <span className="wf-key"><i className="wf-swatch seg-yes" />free tier</span>
            <span className="wf-key"><i className="wf-swatch seg-no" />none</span>
            <span className="wf-key"><i className="wf-swatch seg-un" />unreadable</span>
          </div>
          <p className="drop-note">The unreadable slice is the finding: for most companies the page won’t say.</p>
        </div>

        <div className="sub-card">
          <p className="sub-head">Entry price, the {ep.coverage.readable} with a number</p>
          <div className="stat-inline">
            <Stat small tone="accent" figure={<>{ep.currencies[0]?.currency === 'USD' ? '$' : ''}{ep.median}</>} unit="median entry price, per the lowest readable tier" />
          </div>
          <div className="hist">
            {ep.buckets.map((b, i) => (
              <div key={b.label} className="hist-row">
                <span className="hist-label">{b.label}</span>
                <span className="hist-track">
                  <motion.span className="hist-fill"
                    initial={reduce ? false : { scaleX: 0 }} whileInView={{ scaleX: 1 }}
                    viewport={{ once: true }} transition={{ duration: 0.6, delay: reduce ? 0 : i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                    style={{ width: `${(b.n / bMax) * 100}%` }} />
                </span>
                <span className="hist-n num">{b.n}</span>
              </div>
            ))}
          </div>
          <p className="drop-note">
            Mostly USD ({ep.currencies.map((c) => `${c.n} ${c.currency}`).join(', ')}); the lowest published tier, not a like-for-like plan.
          </p>
        </div>
      </div>

      <Disclosure summary={`Who shows a free tier (${yes}), and who doesn’t (${no})`}>
        <div className="disc-group">
          <p className="disc-group-head"><b>Free tier</b> · {yes}</p>
          <CompanyList companies={ft.yes} />
        </div>
        <div className="disc-group">
          <p className="disc-group-head"><b>No free tier</b> · {no}</p>
          <CompanyList companies={ft.no} />
        </div>
      </Disclosure>
    </Finding>
  );
}
