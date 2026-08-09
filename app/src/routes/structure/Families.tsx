import type { Anatomy } from '../../lib/types';
import { Card, Chip, Chips, Disclosure, Reveal, Stat } from '../../components/ui';
import { buildFamilies, accuracyPct, type FamilyView } from './derive';

function FamilyCard({ f }: { f: FamilyView }) {
  const lead = f.sections[0]?.color ?? 'var(--accent)';
  return (
    <Card hover className="fam-card" style={{ ['--_c' as string]: lead }}>
      <div className="fam-card-head">
        <span className="fam-name">{f.name}</span>
        <span className="fam-size">{f.size}<span> pages</span></span>
      </div>
      {f.sections.length ? (
        <div className="fam-sig">
          {f.sections.map((s) => (
            <span key={s.type} className="fam-sig-chip"
              style={{ borderColor: `color-mix(in srgb, ${s.color} 45%, var(--rule))` }}>
              <i style={{ background: s.color }} />{s.label}
            </span>
          ))}
        </div>
      ) : (
        <span className="fam-sig-empty">no section beyond the hero recurs</span>
      )}
      <p className="fam-members">{f.members.map((m) => m.name).join(' · ')}</p>
    </Card>
  );
}

export function Families({ a }: { a: Anatomy }) {
  const families = buildFamilies(a);
  const c = a.similarity.clusters;
  const acc = accuracyPct(a);
  const clusteredPct = Math.round((c.clustered / c.of) * 100);

  return (
    <div>
      <div className="st-lead">
        <Stat figure={families.length} unit={`shape families among ${c.of} readable pages`} />
        <div className="st-lead-copy">
          <p className="lede">
            Group pages by how alike their section sequences are and only {c.clustered} of {c.of} fall into a
            repeating shape. The other <b>{c.near_unique}</b> are near-unique — in structure, most homepages are
            built one at a time, not from a shared template.
          </p>
          <Chips>
            <Chip tone="judged">judged · classifier ~{acc}% off the hero</Chip>
            <Chip tone="measured">edit-distance &lt; {c.threshold}, families at {c.minSize}+</Chip>
          </Chips>
        </div>
      </div>

      <Card style={{ marginTop: '1.6rem' }}>
        <div className="fam-split" role="img"
          aria-label={`${c.clustered} pages in ${families.length} families, ${c.near_unique} near-unique, of ${c.of}`}>
          {families.map((f) => (
            <div key={f.id} className="fam-split-seg" title={`${f.name} — ${f.size} pages`}
              style={{ width: `${(f.size / c.of) * 100}%`, background: f.sections[0]?.color ?? 'var(--accent)' }} />
          ))}
          <div className="fam-split-rest" title={`${c.near_unique} near-unique pages`} />
        </div>
        <div className="fam-split-key">
          <span><i className="fam-swatch" style={{ background: 'var(--accent)' }} />{c.clustered} in families ({clusteredPct}%)</span>
          <span><i className="fam-swatch" style={{ background: 'color-mix(in srgb, var(--ink-3) 40%, transparent)' }} />{c.near_unique} near-unique ({100 - clusteredPct}%)</span>
        </div>
      </Card>

      <div className="fam-grid" style={{ marginTop: '1.4rem' }}>
        {families.map((f, i) => (
          <Reveal key={f.id} delay={Math.min(i * 0.05, 0.3)}>
            <FamilyCard f={f} />
          </Reveal>
        ))}
      </div>

      <Disclosure summary="Every family and its members">
        {families.map((f) => (
          <p className="st-disc-group" key={f.id}>
            <b>{f.name}</b> · {f.size}{' '}
            <span className="st-disc-names">{f.members.map((m) => m.name).join(', ')}</span>
          </p>
        ))}
      </Disclosure>
    </div>
  );
}
