import { motion } from 'framer-motion';
import { usePositioning } from '../lib/data';
import { Caveat, ErrorNote, Loading } from '../components/ui';
import { HeadlineWords } from './positioning/HeadlineWords';
import { AiAdoption } from './positioning/AiAdoption';
import { CategoryNouns } from './positioning/CategoryNouns';
import { Proof } from './positioning/Proof';
import { Pricing } from './positioning/Pricing';
import './positioning/positioning.css';

export default function Positioning() {
  const { data, error } = usePositioning();

  return (
    <div className="page wrap positioning">
      <section className="pos-hero">
        <motion.p className="kicker"
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          Lens 01 · What every company says it is
        </motion.p>
        <motion.h1 className="pos-title"
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.05 }}>
          The words on the <em>front door</em>.
        </motion.h1>
        <motion.p className="pos-dek"
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.12 }}>
          Five readings of the same corpus: the word each company leads with, whether it sells AI,
          what it calls itself, the proof it shows, and the price. Every figure says what it is out of.
        </motion.p>
      </section>

      {error ? <ErrorNote>Could not load positioning data: {error}</ErrorNote>
        : !data ? <Loading />
        : (
          <>
            <HeadlineWords data={data.headline_words} />
            <AiAdoption data={data.ai_mentions} />
            <CategoryNouns data={data.category_nouns} />
            <Proof data={data.proof_claims} />
            <Pricing data={data.pricing} />

            <Caveat>
              Read the same day; well-known companies only, which is survivorship, not quality. There is
              no conversion data here — it shows what is common, never what works. Category nouns rest on
              a judged read and are the least certain signal on this page.
            </Caveat>
          </>
        )}
    </div>
  );
}
