import { SectionTitle } from '../components/ui';
import { MarketComposition } from './segments/MarketComposition';
import { CrossCuts } from './segments/CrossCuts';
import './segments/segments.css';

export default function Segments() {
  return (
    <div className="page wrap segments">
      <section className="seg-hero">
        <SectionTitle
          kicker="Lens 03"
          title={<>Who’s in the index — and does it change the story?</>}
          lede="First what the sample is made of, then whether the positioning signals bend with who a company is and who it sells to."
        />
      </section>

      <MarketComposition />
      <CrossCuts />
    </div>
  );
}
