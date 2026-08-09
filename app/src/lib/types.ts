/**
 * Types for the published API (docs/api/*.json), the same files the crawl build
 * writes. The app is a pure presentation layer over these; it never invents a
 * number, only shows what the archive published. Only the fields the app reads
 * are typed exhaustively; the rest are permissive.
 */

export interface Coverage {
  tracked: number;
  readable: number;
  unreadable: number;
  held?: number;
  suspect?: number;
  missing?: { slug: string; name: string }[];
}

export interface CompanyRef {
  slug: string;
  name: string;
  text?: string;
}

// ---- positioning.json ----------------------------------------------------

export interface WordRow {
  word: string;
  n: number;
  companies: CompanyRef[];
}
export interface NounGroup {
  noun: string;
  n: number;
  companies: CompanyRef[];
}
export interface ProofKind {
  key: string;
  label: string;
  n: number;
  claims: number;
  note?: string;
  companies: CompanyRef[];
}
export interface LogoRow {
  logo: string;
  n: number;
  companies: CompanyRef[];
}

export interface Positioning {
  headline_words: { words: WordRow[]; coverage: Coverage; distinct_words: number };
  category_nouns: { groups: NounGroup[]; unmatched: CompanyRef[]; coverage: Coverage };
  ai_mentions: {
    mentions: (CompanyRef & { terms?: string[]; fields?: string[] })[];
    quiet: CompanyRef[];
    by_field: { field: string; n: number }[];
    by_term: { term: string; n: number }[];
    coverage: Coverage;
  };
  proof_claims: { kinds: ProofKind[]; total_claims: number; coverage: Coverage };
  logo_mentions: { logos: LogoRow[]; distinct_logos: number; coverage: Coverage };
  pricing: {
    free_tier: { yes: CompanyRef[]; no: CompanyRef[]; coverage: Coverage };
    tiers: { contact_sales: CompanyRef[] };
    entry_price: {
      companies: (CompanyRef & { text: string; tier?: string })[];
      buckets: { label: string; n: number }[];
      currencies: { currency: string; n: number }[];
      median: string;
      coverage: Coverage;
    };
  };
  segments: unknown;
  generated_at: string;
}

// ---- anatomy.json --------------------------------------------------------

export interface Section {
  position: number;
  type: string;
  heading: string | null;
  words: number;
}
export interface Company {
  slug: string;
  name: string;
  segment: string | null;
  status?: string;
  sections: Section[];
}

export interface ElementRow {
  type: string;
  n: number;
  of: number;
  share?: number;
  companies: CompanyRef[];
}
export interface PositionCol {
  position: number;
  n: number;
  types: { type: string; n: number; share: number; companies: CompanyRef[] }[];
}
export interface ScaleRow {
  signal: string;
  label: string;
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  coverage: Coverage;
  extremes: { lowest: { slug: string; name: string; value: number }[]; highest: { slug: string; name: string; value: number }[] };
}

export interface Neighbour { slug: string; distance: number }

export interface ClusterMember { slug: string; name: string }
export interface Cluster {
  id: number;
  size: number;
  sections: string[]; // characteristic section TYPES
  members: ClusterMember[];
}
export interface Clusters {
  threshold: number;
  minSize: number;
  of: number;
  clustered: number;
  near_unique: number;
  clusters: Cluster[];
  note: string;
}

export interface LayoutNode {
  slug: string;
  name: string;
  segment: string | null;
  cluster: number; // -1 = near-unique
  x: number;
  y: number;
  z: number;
}

export interface Accuracy {
  nonHero: number;
  nonHeroCorrect: number;
  nonHeroOf: number;
  overall: number;
  correct: number;
  of: number;
  labelledPages: number;
}

export interface Anatomy {
  quality: {
    sections: number;
    other: number;
    named: number;
    other_share: number | null;
    companies_with_other: { slug: string; name: string; other: number; of: number }[];
    note: string;
  };
  positions: { positions: PositionCol[]; coverage: Coverage };
  elements: { elements: ElementRow[]; coverage: Coverage };
  scales: { scales: ScaleRow[] };
  companies: Company[];
  accuracy: Accuracy;
  labels: Record<string, string>;
  similarity: {
    neighbours: Record<string, Neighbour[]>;
    layout3d: { method: string; radius: number; nodes: LayoutNode[] };
    clusters: Clusters;
  };
  generated_at: string;
}

// ---- facts.json (per-company metadata + clean signals, for cross-cuts) ----

export interface CompanyFact {
  slug: string;
  name: string;
  segment: string | null;
  hq_country: string | null;
  audience: 'b2b' | 'b2b2c' | 'b2c' | null;   // research-judged
  target_size: 'smb' | 'mid-market' | 'enterprise' | 'broad' | null; // research-judged
  category: string | null;                     // research-judged
  meta_confidence: 'high' | 'medium' | 'low' | null;
  ai: boolean | null;          // measured: uses AI language up top; null = unreadable
  free_tier: 'yes' | 'no' | null; // measured; null = pricing unreadable (NOT "no")
}

export interface Facts {
  note: string;
  companies: CompanyFact[];
  generated_at: string;
}

/** The human label for a section type, falling back to the raw key. */
export function sectionLabel(labels: Record<string, string>, type: string): string {
  return labels[type] ?? type;
}
