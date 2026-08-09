import { useAnatomy } from '../lib/data';
import { Card, Chip, Chips, ErrorNote, Loading, Reveal, SectionTitle } from '../components/ui';
import { Archetype } from './structure/Archetype';
import { Families } from './structure/Families';
import { Slots } from './structure/Slots';
import { accuracyPct } from './structure/derive';
import { SimilarityGlobe } from './structure/Globe';
import './structure/structure.css';

export default function Structure() {
  const { data, error } = useAnatomy();

  return (
    <div className="page wrap">
      <div className="st-hero">
        <SectionTitle
          kicker="Lens 02"
          title="Structure"
          lede="How the page is built, not what it says — the archetype every homepage bends toward, the handful of recurring shape families, and who is built like whom."
        />
      </div>

      {error ? (
        <ErrorNote>Could not load anatomy data: {error}</ErrorNote>
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <section className="finding">
            <SectionTitle kicker="Finding 01" title="The archetype homepage" />
            <Reveal><Archetype a={data} /></Reveal>
          </section>

          <section className="finding">
            <SectionTitle kicker="Finding 02" title="A few shapes, then a long tail of one-offs" />
            <Reveal><Families a={data} /></Reveal>
          </section>

          <section className="finding">
            <SectionTitle kicker="Finding 03" title="What sits where" />
            <Reveal><Slots a={data} /></Reveal>
          </section>

          <section className="finding">
            <SectionTitle
              kicker="The map"
              title="Which pages are shaped alike"
              lede="The same edit-distances, laid out in space. Coloured points are the shape families; the pale cloud is the near-unique majority. Spin it to see who sits next to whom."
            />
            <Chips>
              <Chip tone="judged">judged · classifier ~{accuracyPct(data)}% off the hero</Chip>
              <Chip tone="measured">
                {data.similarity.clusters.clusters.length} families · {data.similarity.clusters.near_unique} near-unique · same distances as above
              </Chip>
            </Chips>
            <Card className="globe-wrap" style={{ marginTop: '1.4rem' }}>
              <SimilarityGlobe />
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
