# Vendored third-party code

Everything in this directory is served from this origin. That is the point.

This project makes no third-party request from a visitor's browser -- no CDN, no
web font, no analytics, no embed. Partly hygiene, mostly the law the author works
under: TDDDG section 25 makes reading or storing anything on a visitor's device
conditional on consent, and fetching a script from someone else's server
discloses the visitor's IP to them. The simplest way to need no consent dialogue
is to need no third party.

Downloading a file once and committing it is not the same act as making a
visitor's browser fetch it. These files were fetched at vendoring time, are
pinned by version and hash below, and are read from this domain like any other
asset here.

| File | Version | Bytes | sha256 (first 16) | Source |
|---|---|---|---|---|
| `d3-dispatch.js` | 3.0.1 | 1901 | `94b3bbdb6b98dc13` | jsdelivr `d3-dispatch@3.0.1/dist/d3-dispatch.min.js` |
| `d3-quadtree.js` | 3.0.1 | 5279 | `57e2ad12824ed828` | jsdelivr `d3-quadtree@3.0.1/dist/d3-quadtree.min.js` |
| `d3-timer.js` | 3.0.1 | 1947 | `911ceda305f014b6` | jsdelivr `d3-timer@3.0.1/dist/d3-timer.min.js` |
| `d3-force.js` | 3.0.0 | 8300 | `1e07b47324132879` | jsdelivr `d3-force@3.0.0/dist/d3-force.min.js` |
| `three.module.min.js` | 0.160.0 | 670681 | `3e690ac7d180b0aa` | jsdelivr `three@0.160.0/build/three.module.min.js` |
| `gsap.min.js` | 3.12.5 | 72214 | `28033e449a31ebcc` | jsdelivr `gsap@3.12.5/dist/gsap.min.js` |
| `ScrollTrigger.min.js` | 3.12.5 | 43380 | `ad33c2df9ada8a66` | jsdelivr `gsap@3.12.5/dist/ScrollTrigger.min.js` |

d3: 17,427 bytes (6,058 gzipped). three + gsap: 786,275 bytes (~200kB gzipped).

## Why these, and why served from here

`d3-force` (plus its three real dependencies, 17kB) lays out the flat similarity
graph. Every hand-rolled SVG chart is still rendered at build time; a bar chart
of ten groups does not need a library and rendering it client-side would move a
finding behind a fetch.

`three.module.min.js` renders the WebGL point cloud of the same similarity graph
in 3D. It is loaded as an ES module by relative path from `anatomy-globe.js`
(`import * as THREE from './vendor/three.module.min.js'`) -- no import map, no
bare specifier, no CDN. `gsap.min.js` and `ScrollTrigger.min.js` are the motion
layer (scroll-reveal, number count-ups, chart draw-ins), loaded as classic
globals. All three are enhancement only: the page's findings, charts and tables
are written into the HTML at build time and need none of this to be read, and the
motion layer honours `prefers-reduced-motion`. They are heavier than the d3 four,
and they buy interaction and polish rather than a finding -- which is the line
that keeps them optional.

None of the three makes a network request, uses `eval`/`new Function`, spawns a
worker, or reads storage, so the existing CSP (`script-src 'self'`) covers them
unchanged and the no-third-party guarantee holds.

## Licence

d3: BSD-3-Clause, Copyright 2010-2021 Mike Bostock. Three.js: MIT, Copyright
2010-2023 three.js authors. GSAP core + ScrollTrigger: GreenSock Standard "No
Charge" licence (https://gsap.com/standard-license) -- free for this use,
including self-hosting. Every notice is preserved at the top of each file.

## Updating

Re-fetch, re-hash, update the table, and say so in the commit. A version bump
that nobody wrote down is indistinguishable from a compromised file.
