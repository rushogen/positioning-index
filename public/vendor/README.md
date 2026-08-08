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

17,427 bytes total, 6,058 gzipped.

## Why these four and not d3

`d3` is roughly 280kB and this site needs one thing from it: a force simulation
to lay out a similarity graph. `d3-force` plus its three actual dependencies is
17kB. Every other chart here is hand-rolled SVG rendered at build time, because a
bar chart of ten groups does not need a library and rendering it client-side
would move a finding behind a fetch.

## Licence

BSD-3-Clause, Copyright 2010-2021 Mike Bostock. The notice is preserved at the
top of each file.

## Updating

Re-fetch, re-hash, update the table, and say so in the commit. A version bump
that nobody wrote down is indistinguishable from a compromised file.
