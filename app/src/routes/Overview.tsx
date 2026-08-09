import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAnatomy, usePositioning } from '../lib/data';
import { Card, Reveal, Stat } from '../components/ui';
import './overview.css';

export function Overview() {
  const { data: anatomy } = useAnatomy();
  const { data: pos } = usePositioning();

  const companies = pos?.headline_words.coverage.tracked ?? anatomy?.similarity.clusters.of ?? 225;
  const sectionsRead = anatomy?.quality.sections ?? null;
  const readable = anatomy?.positions.coverage.readable ?? null;
  const families = anatomy?.similarity.clusters.clusters.length ?? null;
  const topNoun = pos?.category_nouns.groups[0];
  const nounOf = pos?.category_nouns.coverage.readable ?? null;
  const aiN = pos?.ai_mentions.mentions.length ?? null;
  const aiOf = pos?.ai_mentions.coverage.readable ?? null;

  return (
    <div className="page overview wrap">
      <section className="ov-hero">
        <motion.p className="ov-kicker"
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          A measured field guide · {companies} companies · read the same day
        </motion.p>
        <motion.h1 className="ov-title"
          initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.05 }}>
          How B2B SaaS builds<br />its <em>front door</em>.
        </motion.h1>
        <motion.p className="ov-dek"
          initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.12 }}>
          Every well-known company in the category, read the same way on the same day — the words in their
          headlines and the structure they ship. Two lenses on the same corpus.
        </motion.p>

        <div className="ov-stats">
          <Stat small figure={companies} unit="companies, homepage & pricing" />
          <Stat small tone="green" figure={sectionsRead ?? '—'} unit="homepage sections read" />
          <Stat small tone="ink" figure={readable ?? '—'} unit="pages the structure could read" />
        </div>
      </section>

      <section className="ov-tabs grid grid-2">
        <Reveal>
          <Card hover className="ov-card">
            <p className="ov-card-tag">Lens 01</p>
            <h2>Positioning</h2>
            <p className="ov-card-lede">What every company says it is — the words, the category noun, the AI
              claims, the proof, the price.</p>
            {topNoun && (
              <p className="ov-card-stat">
                <b className="num">{topNoun.n}</b> of {nounOf} call themselves a
                &ldquo;{topNoun.noun}&rdquo;{aiN != null && <> · <b className="num">{aiN}</b> of {aiOf} sell AI</>}
              </p>
            )}
            <Link to="/positioning" className="ov-go">Open Positioning →</Link>
          </Card>
        </Reveal>

        <Reveal delay={0.08}>
          <Card hover className="ov-card">
            <p className="ov-card-tag">Lens 02</p>
            <h2>Structure</h2>
            <p className="ov-card-lede">How the page is built, not what it says — the archetype, the recurring
              shape families, and who is built like whom.</p>
            {families != null && (
              <p className="ov-card-stat">
                <b className="num">{families}</b> recurring shape families · <b className="num">{anatomy!.similarity.clusters.near_unique}</b> pages
                near-unique
              </p>
            )}
            <Link to="/structure" className="ov-go">Open Structure →</Link>
          </Card>
        </Reveal>
      </section>

      <p className="ov-note">
        Not a survey and not opinion. Each reading is a public, timestamped commit; every figure says what it is
        out of. It measures what the market does, never what works. <Link to="/method">How it&rsquo;s measured →</Link>
      </p>
    </div>
  );
}
