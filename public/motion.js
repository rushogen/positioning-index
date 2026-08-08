/*
  motion.js — the essay's motion layer.

  ENHANCEMENT ONLY. Every finding, number, chart and table on this page is
  written into the file by bin/build-site.js and is on screen before this script
  runs; app.js owns the section-level reveal. This file adds finer motion INSIDE
  sections -- numbers that count up, bars that draw in, chips that fade -- and
  removes nothing.

  It is built so it can never leave content stuck hidden or zeroed:

    - No GSAP on the page: it returns on the first line and touches nothing.
    - prefers-reduced-motion: reduce: it returns before applying any hidden
      state, so every number sits at its final value and every bar is full.
    - Every "hidden" starting state (a bar at scaleX:0, a number at 0) is applied
      by JavaScript, never in CSS, so a reader with JS off, with GSAP missing, or
      hitting an error path always sees the real content.
    - A visibility-checked failsafe finalises anything already on screen that a
      ScrollTrigger somehow never fired for, and any thrown error finalises
      everything. Off-screen items stay armed and animate on scroll.

  It animates only transform and opacity (and textContent for the count-ups),
  never layout properties.
*/
'use strict';

(function () {
  // No motion library, nothing to enhance. The page is already complete.
  if (!window.gsap) return;

  const gsap = window.gsap;
  const ST = window.ScrollTrigger || null;

  // Reduced motion: leave every number final and every bar/chip visible. We have
  // not applied any hidden state yet, so returning here is the whole of it.
  const mm = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  if (mm && mm.matches) return;

  // ScrollTrigger is the trigger mechanism when present; if it is somehow absent
  // we fall back to animating on load (see reveal() below).
  if (ST) gsap.registerPlugin(ST);

  // Origin for the SVG marks. The stylesheet sets transform-box:fill-box and
  // transform-origin:left center on these, but GSAP writes its own default
  // (centre) unless told otherwise, which would scale the bars from the middle.
  const LEFT = 'left center';

  // Registry backing the failsafe. Each entry can be finalised exactly once.
  const reg = [];
  const finalizeAll = () => { for (const e of reg) { try { e.finalize(); } catch (_) { /* keep going */ } } };

  /*
   * Run `animate` once when `trigger` scrolls into view; `finalize` jumps
   * straight to the end state and is what the failsafe and the error path call.
   * once:true with start 'top 85%' means above-the-fold triggers fire on load.
   */
  function reveal(trigger, animate, finalize) {
    const entry = {
      el: trigger,
      done: false,
      finalize() { if (this.done) return; this.done = true; finalize(); },
    };
    const run = () => { if (entry.done) return; entry.done = true; animate(); };
    reg.push(entry);
    if (ST) {
      ST.create({ trigger, start: 'top 85%', once: true, onEnter: run });
    } else {
      run(); // no ScrollTrigger: animate on load rather than not at all
    }
  }

  // ------------------------------------------------------------ 1. count-ups
  //
  // Parsed shapes: a plain integer ("20"), a number with a '%' suffix
  // ("40%", "6.2%"), and a leading currency symbol + number ("$50"). Anything
  // else -- "8 of 9", "—", a value with letters -- does not match and is left
  // exactly as the build wrote it. Math.round is used while counting; the final
  // frame restores the original text byte for byte, so the displayed value never
  // changes from what was in the HTML.
  const NUM = /^([$£€¥]?)(\d[\d,]*(?:\.\d+)?)(%?)$/;

  function armCount(el) {
    const raw = el.textContent;
    const m = raw.trim().match(NUM);
    if (!m) return;                                  // not cleanly numeric: skip
    const prefix = m[1];
    const suffix = m[3];
    const target = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(target)) return;

    const proxy = { v: 0 };
    const paint = (n) => { el.textContent = prefix + Math.round(n) + suffix; };
    const animate = () => {
      gsap.killTweensOf(proxy);
      proxy.v = 0;
      paint(0);
      gsap.to(proxy, {
        v: target,
        duration: 0.9,
        ease: 'power2.out',
        onUpdate: () => paint(proxy.v),
        onComplete: () => { el.textContent = raw; }, // exact original, unchanged
      });
    };
    const finalize = () => { gsap.killTweensOf(proxy); el.textContent = raw; };

    paint(0);                        // JS-applied zero; only set when we will animate
    reveal(el, animate, finalize);
  }

  // ------------------------------------------------------------ 2. bar draw-ins
  //
  // Only the always-visible charts inside #essay .finding-viz. The archetype
  // mock skins (.mk-*) and the collapsed inspect tables inside <details> are not
  // touched. The initial scaleX:0 is applied with gsap.set only -- never in CSS
  // -- so a run that never happens leaves the bars at full width.
  function armViz(viz) {
    const marks = viz.querySelectorAll('.bar-fill, .seg');
    if (!marks.length) return;
    // Cap the stagger spread so a chart with many rows still resolves quickly.
    const each = Math.min(0.04, 0.5 / marks.length);
    const animate = () => {
      gsap.fromTo(marks,
        { scaleX: 0, transformOrigin: LEFT },
        { scaleX: 1, transformOrigin: LEFT, duration: 0.5, ease: 'power2.out', stagger: each, overwrite: 'auto' });
    };
    const finalize = () => gsap.set(marks, { scaleX: 1, transformOrigin: LEFT });

    gsap.set(marks, { scaleX: 0, transformOrigin: LEFT });
    reveal(viz, animate, finalize);
  }

  // ------------------------------------------------------------ 3. chip fade-in
  function armChips(head) {
    const chips = head.querySelectorAll('.chips .chip');
    if (!chips.length) return;
    const animate = () => {
      gsap.fromTo(chips,
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out', stagger: 0.05, overwrite: 'auto' });
    };
    const finalize = () => gsap.set(chips, { opacity: 1, y: 0 });

    gsap.set(chips, { opacity: 0, y: 6 });
    reveal(head, animate, finalize);
  }

  try {
    // The lead figure of each finding, and the KPI row.
    document.querySelectorAll('#essay .stat-fig, .kpis dd').forEach(armCount);
    // The always-visible charts, per figure so the stagger is scoped to each.
    document.querySelectorAll('#essay .finding-viz').forEach(armViz);
    // The caveat chips beside each finding's heading.
    document.querySelectorAll('#essay .finding-head').forEach(armChips);
  } catch (_) {
    finalizeAll(); // never leave anything hidden or zeroed because we threw
    return;
  }

  // Failsafe: finalise anything already on screen that a trigger never fired for
  // (a backgrounded tab at load, ScrollTrigger failing to initialise). Content
  // below the fold stays armed and animates on scroll as normal.
  const sweep = () => {
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    for (const e of reg) {
      if (e.done || !e.el || typeof e.el.getBoundingClientRect !== 'function') continue;
      const r = e.el.getBoundingClientRect();
      if (r.top < vh + 100) e.finalize();
    }
  };
  window.addEventListener('load', () => { if (ST) ST.refresh(); }, { once: true });
  setTimeout(sweep, 3500);
})();
