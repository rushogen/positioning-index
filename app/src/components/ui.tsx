/**
 * Shared UI primitives. Every view is built from these so the app reads as one
 * instrument: the same card, the same big-stat treatment, the same caveat chips.
 * Keep new shared visuals here; keep view-specific pieces in the view's folder.
 */
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import './ui.css';

export function Card({ children, className = '', hover = false, style }: {
  children: ReactNode; className?: string; hover?: boolean; style?: React.CSSProperties;
}) {
  return <div className={`card ${hover ? 'card-hover' : ''} ${className}`} style={style}>{children}</div>;
}

/** The lead number of a finding: big serif figure + its denominator/unit. */
export function Stat({ figure, unit, tone = 'accent', small = false }: {
  figure: ReactNode; unit?: ReactNode; tone?: 'accent' | 'ink' | 'green' | 'hot'; small?: boolean;
}) {
  return (
    <div className={`stat ${small ? 'stat-sm' : ''}`}>
      <span className={`stat-fig num tone-${tone}`}>{figure}</span>
      {unit && <span className="stat-unit">{unit}</span>}
    </div>
  );
}

export type ChipTone = 'measured' | 'judged' | 'coverage' | 'note' | 'accent';
export function Chip({ tone = 'note', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}
export function Chips({ children }: { children: ReactNode }) {
  return <div className="chips">{children}</div>;
}

/** Section header: small kicker, serif title, optional lede. */
export function SectionTitle({ kicker, title, lede }: { kicker?: string; title: ReactNode; lede?: ReactNode }) {
  return (
    <header className="section-title">
      {kicker && <p className="kicker">{kicker}</p>}
      <h2>{title}</h2>
      {lede && <p className="lede">{lede}</p>}
    </header>
  );
}

/** The honesty line — always available, never a hidden footnote. */
export function Caveat({ children }: { children: ReactNode }) {
  return <p className="caveat">{children}</p>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="state-msg"><span className="spinner" aria-hidden />{label}</div>;
}
export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="state-msg state-err" role="alert">{children}</div>;
}

/** Fade-up on enter; respects reduced motion via theme.css disabling durations. */
export function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Collapsible "who's behind this" — the company lists that make a bar checkable. */
export function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="disclosure">
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
