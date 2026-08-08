/**
 * Score the section classifier against hand-labelled ground truth, in-process.
 *
 * scripts/score-anatomy.js is the command a person runs. This is the same
 * measurement as a pure function, so bin/build-site.js can compute the number
 * at build time and publish it beside every figure that depends on it.
 *
 * WHY THE BUILD MEASURES IT RATHER THAN READING A CONSTANT
 * --------------------------------------------------------
 * A hardcoded accuracy is a claim with an expiry date and no alarm on it. Change
 * the classifier, forget the constant, and the site keeps publishing the old
 * number next to the new output -- which is precisely the failure already
 * recorded in CORRECTIONS.md for the README's cost table. Deriving it means the
 * caveat cannot drift from the thing it is describing.
 *
 * With no labels it returns zero counts, and the caveat downstream says the
 * classifier is unmeasured. That is the honest reading of an empty label file,
 * and it is deliberately not the same sentence as a measured low score.
 */
import { pageAnatomy } from './anatomy-insights.js';

const HERO_KEY = '__hero__';
const keyOf = (s) => (s.position === 1 && !s.heading ? HERO_KEY : (s.heading ?? `__pos${s.position}__`));

export function scoreClassifier({ seed, series, labels }) {
  const entries = labels?.labels ?? [];
  const anatomy = pageAnatomy({ companies: seed.companies, series });
  const predicted = new Map(anatomy.companies.map((c) => [c.slug, c]));

  let matched = 0;
  let correct = 0;
  let nonHero = 0;
  let nonHeroCorrect = 0;
  const pages = new Set();

  for (const entry of entries) {
    const got = predicted.get(entry.slug);
    if (!got?.sections) continue;
    pages.add(entry.slug);
    const byKey = new Map(got.sections.map((s) => [keyOf(s), s.type]));
    for (const truth of entry.sections ?? []) {
      const guess = byKey.get(truth.heading ?? HERO_KEY);
      if (guess === undefined) continue;
      matched++;
      if (guess === truth.type) correct++;
      if (truth.type !== 'hero') {
        nonHero++;
        if (guess === truth.type) nonHeroCorrect++;
      }
    }
  }

  return {
    labelled_pages: pages.size,
    matched,
    correct,
    non_hero: nonHero,
    non_hero_correct: nonHeroCorrect,
    measured_at: null,          // the build is deterministic; no clock here
    command: 'node scripts/score-anatomy.js',
    source: 'scripts/score-anatomy.js against seed/labels.json',
  };
}
