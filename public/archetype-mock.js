/*
  The archetype mock: interaction.

  The page-shaped mock and every section's insight are written into the document
  at build time (src/archetype-mock.js). This upgrades it: selecting a block
  shows that section's insight in a panel beside the page instead of jumping the
  reader down a list. With scripting off, none of this runs and the blocks are
  plain anchors that jump to the same insight, written out in full below the
  mock -- so the finding is never behind JS.

  All rendering here is cloning nodes the build already produced (the insight
  cards), never innerHTML with data -- the company names in those cards are data
  we display, not markup we trust.
*/

'use strict';

(function archetypeMock() {
  const root = document.getElementById('anatomy-mock');
  if (!root) return;

  const blocks = Array.from(root.querySelectorAll('.mk-sec'));
  const panel = root.querySelector('#mk-panel');
  const cards = new Map(
    Array.from(root.querySelectorAll('.mk-insight')).map((c) => [c.dataset.type, c])
  );
  if (!blocks.length || !panel || !cards.size) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let selected = null;

  function hint() {
    panel.replaceChildren();
    const p = document.createElement('p');
    p.className = 'mk-hint';
    p.textContent = 'Select a section of the page to see how common it is, where it sits, and who leaves it out.';
    panel.append(p);
    panel.hidden = false;
  }

  function fill(type) {
    const card = cards.get(type);
    if (!card) return;
    panel.replaceChildren();
    // Clone the build-rendered insight card; it already holds escaped text and
    // real company links, one source of truth. Snapshot the child nodes to an
    // array first: appending each to the panel removes it from the live clone,
    // and iterating a NodeList while it mutates skips half the nodes.
    for (const node of Array.from(card.cloneNode(true).childNodes)) panel.append(node);
    panel.hidden = false;
  }

  function select(type, { scroll = false } = {}) {
    selected = type;
    for (const b of blocks) b.setAttribute('aria-current', String(b.dataset.type === type));
    fill(type);
    if (scroll && window.matchMedia('(max-width: 60rem)').matches) {
      panel.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'nearest' });
    }
  }

  // Hover and focus preview without pinning; click/Enter pins and (on a narrow
  // screen, where the panel is below the page) brings the panel into view.
  for (const [i, b] of blocks.entries()) {
    b.addEventListener('mouseenter', () => fill(b.dataset.type));
    b.addEventListener('focus', () => select(b.dataset.type));
    b.addEventListener('click', (e) => { e.preventDefault(); select(b.dataset.type, { scroll: true }); });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); blocks[Math.min(blocks.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); blocks[Math.max(0, i - 1)].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); blocks[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); blocks[blocks.length - 1].focus(); }
      else if (e.key === 'Escape' && selected) { selected = null; for (const x of blocks) x.setAttribute('aria-current', 'false'); hint(); }
    });
  }

  // Leaving the mock with nothing pinned returns the panel to its hint, so it is
  // never a stale fragment of whatever was last hovered.
  root.querySelector('.mk-page').addEventListener('mouseleave', () => { if (!selected) hint(); });

  hint();
})();
