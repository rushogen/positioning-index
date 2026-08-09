/**
 * Layout parts shared by every Positioning finding, so the tab reads as one
 * instrument: a numbered finding shell, and the company lists that make a bar
 * checkable. Company names are DATA — always rendered as React text.
 */
import type { ReactNode } from 'react';
import type { CompanyRef } from '../../lib/types';
import { Reveal } from '../../components/ui';

/** A numbered finding: kicker + title, then the body (lead stat, viz, disclosure). */
export function Finding({ n, kicker, title, children }: {
  n: string; kicker: string; title: ReactNode; children: ReactNode;
}) {
  return (
    <Reveal className="finding">
      <header className="finding-head">
        <span className="finding-num num" aria-hidden>{n}</span>
        <div>
          <p className="kicker">{kicker}</p>
          <h2 className="finding-title">{title}</h2>
        </div>
      </header>
      {children}
    </Reveal>
  );
}

/** A checkable list of the companies behind a row, optionally with their read text. */
export function CompanyList({ companies, showText = false }: {
  companies: CompanyRef[]; showText?: boolean;
}) {
  return (
    <ul className="co-list">
      {companies.map((c) => (
        <li key={c.slug} className={showText ? 'co-row' : undefined}>
          <span className="co-name">{c.name}</span>
          {showText && c.text && <span className="co-text">{c.text}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Names only, as a dense inline set — for "who does NOT" style call-outs. */
export function NameCloud({ companies }: { companies: CompanyRef[] }) {
  return (
    <div className="name-cloud">
      {companies.map((c) => <span key={c.slug} className="name-tag">{c.name}</span>)}
    </div>
  );
}
