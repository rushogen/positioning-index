import { useMemo } from 'react';
import { useAnatomy, usePositioning, useFacts } from '../lib/data';
import { crossCut } from '../lib/filter';
import { sectionLabel } from '../lib/types';
import { Card, Chip, Chips, ErrorNote, Loading, Reveal, SectionTitle, Stat } from '../components/ui';
import './playbook.css';

const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);

export default function Playbook() {
  const { data: pos, error: e1 } = usePositioning();
  const { data: anatomy, error: e2 } = useAnatomy();
  const { data: facts, error: e3 } = useFacts();

  const model = useMemo(() => {
    if (!pos || !anatomy || !facts) return null;
    const labels = anatomy.labels;
    const nouns = pos.category_nouns;
    const topNoun = nouns.groups[0];
    const secondNoun = nouns.groups[1];
    const ai = pos.ai_mentions;

    // Section prevalence (hero is 100% by construction and excluded from the model).
    const bands = anatomy.elements.elements
      .map((e) => ({ label: sectionLabel(labels, e.type), pct: pct(e.n, e.of), n: e.n, of: e.of }))
      .sort((a, b) => b.pct - a.pct);

    const clusters = anatomy.similarity.clusters;
    const proof = [...pos.proof_claims.kinds].sort((a, b) => b.n - a.n);
    const timeProof = pos.proof_claims.kinds.find((k) => k.key === 'time');

    const c = facts.companies;
    const cc = (dim: 'target_size' | 'audience', ans: (x: (typeof c)[number]) => boolean | null) =>
      crossCut(c, (x) => x[dim], ans).filter((g) => !g.suppressed);
    const aiAns = (x: (typeof c)[number]) => x.ai;
    const ftAns = (x: (typeof c)[number]) => (x.free_tier === 'yes' ? true : x.free_tier === 'no' ? false : null);

    return {
      total: nouns.coverage.tracked,
      topNoun, secondNoun, nounReadable: nouns.coverage.readable, nounPct: pct(topNoun?.n ?? 0, nouns.coverage.readable),
      aiN: ai.mentions.length, aiOf: ai.coverage.readable, aiPct: pct(ai.mentions.length, ai.coverage.readable),
      bands,
      featureGrid: bands.find((b) => /feature grid/i.test(b.label)),
      clusters,
      topFamily: clusters.clusters[0],
      proof, timeProof, topProof: proof[0],
      aiBySize: cc('target_size', aiAns),
      aiByAud: cc('audience', aiAns),
      ftBySize: cc('target_size', ftAns),
      readablePages: anatomy.elements.coverage.readable,
    };
  }, [pos, anatomy, facts]);

  if (e1 || e2 || e3) return <div className="page wrap"><ErrorNote>Could not load the data: {e1 || e2 || e3}</ErrorNote></div>;
  if (!model) return <div className="page wrap"><Loading /></div>;

  const m = model;
  const quietPct = 100 - m.aiPct;

  return (
    <div className="page wrap playbook">
      <section className="pb-hero">
        <p className="kicker">Playbook · synthesis</p>
        <h1 className="pb-title">What to copy, and where to <em>break rank</em>.</h1>
        <p className="pb-dek">
          The convention across {m.total} companies, and the places the whole category looks identical —
          so a deviation gets noticed at almost no cost. Every figure is read live from the corpus and moves
          with each crawl.
        </p>
        {/* The non-negotiable frame — this is the one tab that gives guidance. */}
        <div className="pb-warning" role="note">
          <strong>Read this first.</strong> This index measures what the market <em>does</em>, never what
          <em> works</em> — there is no conversion data anywhere in it. Every &ldquo;stand out&rdquo; move below is
          reasoning from <b>convention and contrast</b> (where the herd is uniform, difference is cheap to notice),
          not proof that it performs. Treat it as a map of the category, not a growth guarantee.
        </div>
      </section>

      {/* 1 — the convention */}
      <Reveal>
        <section className="pb-section">
          <SectionTitle kicker="01 · The convention" title="Adopt the recognizable shape" />
          <div className="pb-split">
            <div>
              <p className="pb-lead">
                Only the opening is truly standard: a <b>hero on 100%</b> of pages, then a
                <b> feature grid on {m.featureGrid?.pct ?? 76}%</b>. Everything after thins out fast, and there is
                no standard order — <b>{m.clusters.near_unique} of {m.clusters.of}</b> pages have a near-unique
                section sequence. So a clever section order buys no distinctiveness; the shape below is table stakes.
              </p>
              <Chips>
                <Chip tone="judged">structure is classifier-read (~{pct(anatomy?.accuracy.nonHeroCorrect ?? 61, anatomy?.accuracy.nonHeroOf ?? 124)}% off-hero)</Chip>
                <Chip tone="measured">{m.readablePages} readable pages</Chip>
              </Chips>
            </div>
            <Card className="pb-spine">
              <p className="pb-spine-row"><span className="pb-spine-name">Hero</span><span className="pb-spine-bar"><i style={{ width: '100%' }} /></span><b>100%</b></p>
              {m.bands.slice(0, 7).map((b) => (
                <p className="pb-spine-row" key={b.label}>
                  <span className="pb-spine-name">{b.label}</span>
                  <span className="pb-spine-bar"><i style={{ width: `${b.pct}%` }} /></span>
                  <b>{b.pct}%</b>
                </p>
              ))}
            </Card>
          </div>
        </section>
      </Reveal>

      {/* 2 — vocabulary */}
      <Reveal>
        <section className="pb-section">
          <SectionTitle kicker="02 · The cheapest lever" title="The words are where everyone looks identical" />
          <div className="grid grid-2">
            <Card>
              <Stat figure={`${m.nounPct}%`} unit={`call themselves a “${m.topNoun?.noun}” (${m.topNoun?.n} of ${m.nounReadable})`} />
              <p className="pb-note">
                &ldquo;{m.topNoun?.noun}&rdquo; is the most crowded word in the category{m.secondNoun ? `, far ahead of “${m.secondNoun.noun}” (${m.secondNoun.n})` : ''}. Using it is
                camouflage. A concrete, specific self-description differentiates at zero cost.
              </p>
            </Card>
            <Card>
              <Stat tone="hot" figure={`${m.aiPct}%`} unit={`put AI / agent language in the first thing you read (${m.aiN} of ${m.aiOf})`} />
              <p className="pb-note">
                AI positioning is saturated. The <b>{quietPct}%</b> who stay quiet on AI are an uncrowded lane —
                worth it if your buyer is AI-fatigued, or if your edge isn&rsquo;t the model.
              </p>
            </Card>
          </div>
        </section>
      </Reveal>

      {/* 3 — how to stand out */}
      <Reveal>
        <section className="pb-section">
          <SectionTitle kicker="03 · Where to break rank" title="Deviate where the herd is uniform" />
          <ol className="pb-moves">
            <li><b>Drop &ldquo;{m.topNoun?.noun}.&rdquo;</b> {m.nounPct}% of the category self-describes with it — a specific &ldquo;the X for Y&rdquo; stands out against that default for free.</li>
            <li><b>Make your AI stance deliberate.</b> With {m.aiPct}% shouting AI, either out-specify them (what it does, with a number) or take the quiet-on-AI lane. Generic &ldquo;AI-powered {m.topNoun?.noun}&rdquo; is camouflage squared.</li>
            <li><b>Prove differently.</b> Proof is dominated by {m.topProof?.label.toLowerCase()} ({m.topProof?.n}) and percentage gains; <b>time-to-result is rare ({m.timeProof?.n ?? 0})</b> — and it&rsquo;s the claim buyers actually ask about.</li>
            <li><b>Don&rsquo;t chase a novel page order.</b> {m.clusters.near_unique} of {m.clusters.of} pages are already near-unique in sequence, so order buys nothing. Spend the effort inside the hero and feature grid — the two sections everyone reads.</li>
          </ol>
        </section>
      </Reveal>

      {/* 4 — tailor by who you sell to */}
      <Reveal>
        <section className="pb-section">
          <SectionTitle kicker="04 · Tailor it" title="It shifts with who you sell to" lede="Grouping is research-judged, not read off the page; rates exclude companies whose signal couldn't be read." />
          <div className="grid grid-3">
            <CutCard title="Sell AI, by size" rows={m.aiBySize} note="Enterprise leads — the bigger the buyer, the more AI is front-and-centre. Include a security/compliance band there." />
            <CutCard title="Sell AI, by audience" rows={m.aiByAud} note="b2b2c (dev / infra / payments) is a touch quieter on AI — that audience rewards specifics over positioning." />
            <CutCard title="Publish a free tier, by size" rows={m.ftBySize} note="Near-universal for self-serve; omitting it reads as enterprise / contact-sales. (Among companies whose pricing could be read.)" />
          </div>
        </section>
      </Reveal>

      {/* bottom line */}
      <Reveal>
        <section className="pb-section pb-bottom">
          <SectionTitle kicker="The bottom line" title="Structure is table stakes; vocabulary is the lever" />
          <p className="pb-lead">
            Adopt the recognizable shape (hero → feature grid → a proof / testimonial / security band → CTA) so you read
            as a real category player. Then spend your entire differentiation budget on the <b>words in the hero</b>: a
            non-&ldquo;{m.topNoun?.noun}&rdquo; category noun, a deliberate AI stance, and a time-to-value proof point. That&rsquo;s
            where {m.nounPct}% of the market looks the same.
          </p>
        </section>
      </Reveal>
    </div>
  );
}

function CutCard({ title, rows, note }: { title: string; rows: { group: string; yes: number; readable: number; rate: number }[]; note: string }) {
  const label = (g: string) => g.replace('mid-market', 'mid').replace(/(^|\s)\w/g, (s) => s.toUpperCase());
  return (
    <Card>
      <h3 className="pb-cut-title">{title}</h3>
      <ul className="pb-cut">
        {rows.map((r) => (
          <li key={r.group}>
            <span className="pb-cut-name">{label(r.group)}</span>
            <span className="pb-cut-bar"><i style={{ width: `${Math.round(r.rate * 100)}%` }} /></span>
            <b>{Math.round(r.rate * 100)}%</b>
            <span className="pb-cut-n">{r.yes}/{r.readable}</span>
          </li>
        ))}
      </ul>
      <p className="pb-note">{note}</p>
    </Card>
  );
}
