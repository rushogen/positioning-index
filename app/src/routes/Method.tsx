import { useAnatomy } from '../lib/data';
import { Card, Chip, Chips, SectionTitle, Stat } from '../components/ui';

export function Method() {
  const { data: anatomy } = useAnatomy();
  const acc = anatomy?.accuracy;

  return (
    <div className="page wrap" style={{ maxWidth: '52rem' }}>
      <SectionTitle
        kicker="Method"
        title="How this was measured, and what it will not claim"
        lede="The value of this archive is that it refuses to guess. It reads two public pages per company, records what it can, and says plainly what it cannot."
      />

      <div className="grid grid-2" style={{ margin: '2rem 0' }}>
        <Card>
          <Stat small tone="ink" figure="12" unit="signals read per company — headline, subhead, category noun, proof, logos, and from the pricing page the tiers, entry price, free tier and seat minimum" />
        </Card>
        <Card>
          <Stat small tone="hot"
            figure={acc ? `${Math.round(acc.nonHero * 100)}%` : '—'}
            unit={acc ? `section-classifier accuracy off the hero (${acc.nonHeroCorrect} of ${acc.nonHeroOf} on ${acc.labelledPages} hand-labelled pages)` : 'classifier accuracy'} />
          <Chips>
            <Chip tone="measured">measured = read off the page</Chip>
            <Chip tone="judged">judged = rests on the classifier</Chip>
          </Chips>
        </Card>
      </div>

      <div className="prose">
        <p>
          There is no conversion data anywhere in it, so it can tell you what is common and never what works. The
          companies are well-known, which is survivorship, not a quality filter. Section types are read by a
          classifier that is right about half the time off the hero, and every figure that rests on it is marked
          <Chip tone="judged">judged</Chip>. Where a page could not be read, it is counted as unread, not as an
          absence.
        </p>
        <p>
          Each crawl lands as a timestamped commit, so a number you cite today can be traced to the bytes that
          produced it. Low-signal rows — a category two companies use, a cross-cut over six — are dropped rather
          than drawn faintly, because for an audience that wants signal they are noise.
        </p>
        <p>
          Everything here is self-hosted: no CDN, no web font from a third party, no analytics, no charting service.
          The page sets no cookies and makes no third-party request.
        </p>
      </div>
    </div>
  );
}
