-- The B2B SaaS Positioning Index -- D1 schema
--
-- Design notes
-- ------------
-- 1. Timestamps are TEXT, ISO-8601, UTC, always in the form YYYY-MM-DDTHH:MM:SSZ.
--    Lexicographic order == chronological order, so BETWEEN and ORDER BY work
--    without any date parsing, and every index below is a usable time-series index.
--
-- 2. `observations` is append-only. Nothing in the codebase issues UPDATE or
--    DELETE against it. The whole product is the history; mutating it would
--    destroy the only asset.
--
-- 3. `signal_state` is the derived "where things stand right now" table. It is
--    a cache of the newest row in `observations` plus the parser-health counters
--    that the diff engine needs in order to distinguish a company changing its
--    headline from our extractor breaking. Losing it is recoverable: it can be
--    rebuilt entirely from `observations`.
--
-- 4. Write budget. D1's free tier allows 100k rows written per day. A run over
--    ~55 companies x 2 pages x ~11 signals is under 1,300 observation rows,
--    plus ~110 fetch rows and a handful of change events. Roughly 1.5k writes
--    per day against a 100k budget -- about 1.5% -- which leaves room to grow
--    the index to several hundred companies without touching the cadence.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id             INTEGER PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,          -- url-safe id, e.g. "linear"
  name           TEXT NOT NULL,                 -- display name, e.g. "Linear"
  homepage_url   TEXT NOT NULL,
  pricing_url    TEXT,                          -- NULL where the company publishes no pricing page
  segment        TEXT NOT NULL,                 -- coarse market bucket, for filtering the index
  hq_country     TEXT,
  added_at       TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1     -- 0 = retired (acquired, dead, permanently blocking us)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_companies_active ON companies(active, slug);

-- ---------------------------------------------------------------------------
-- targets -- the crawl work queue
--
-- One row per (company, page kind). The scheduler picks the single most overdue
-- target per tick. This is what keeps each invocation inside the CPU budget and
-- what enforces "at most one request per domain per tick".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS targets (
  id                    INTEGER PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('home', 'pricing')),
  url                   TEXT NOT NULL,
  host                  TEXT NOT NULL,
  next_due_at           TEXT NOT NULL,          -- scheduler orders on this
  last_attempted_at     TEXT,
  last_ok_at            TEXT,
  last_status           TEXT,                   -- mirrors fetches.status
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  etag                  TEXT,                   -- conditional-request cache
  last_modified         TEXT,
  content_hash          TEXT,                   -- FNV-1a of normalised body; skips work when unchanged
  enabled               INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, kind)
) STRICT;

-- The scheduler's hot query: "the most overdue enabled target".
CREATE INDEX IF NOT EXISTS idx_targets_due ON targets(enabled, next_due_at);
CREATE INDEX IF NOT EXISTS idx_targets_host ON targets(host);

-- ---------------------------------------------------------------------------
-- robots_cache -- one row per host, so robots.txt costs one request per day
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS robots_cache (
  host          TEXT PRIMARY KEY,
  body          TEXT,                           -- raw robots.txt; NULL when unfetchable
  http_status   INTEGER,
  fetched_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  crawl_delay_s REAL,                           -- parsed Crawl-delay for our UA group
  fetch_error   TEXT
) STRICT;

-- ---------------------------------------------------------------------------
-- runs -- a run is one daily sweep of the index
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY,
  started_at     TEXT NOT NULL,
  closed_at      TEXT,
  targets_total  INTEGER NOT NULL DEFAULT 0,
  fetch_ok       INTEGER NOT NULL DEFAULT 0,
  fetch_blocked  INTEGER NOT NULL DEFAULT 0,
  fetch_error    INTEGER NOT NULL DEFAULT 0,
  fetch_structure INTEGER NOT NULL DEFAULT 0,
  changes_found  INTEGER NOT NULL DEFAULT 0,
  parser_faults  INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

-- ---------------------------------------------------------------------------
-- fetches -- every HTTP attempt, successful or not
--
-- This table is the answer to "did the crawler quietly die at 3am?". A run that
-- produces no change events but also no `ok` fetches is a broken crawler, and
-- the health endpoint reads exactly that.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fetches (
  id             INTEGER PRIMARY KEY,
  run_id         INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  target_id      INTEGER REFERENCES targets(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL,
  url            TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  http_status    INTEGER,
  -- ok               fetched, parsed, extraction yield within tolerance
  -- blocked          robots.txt disallowed, or 401/403/429, or a bot wall
  -- changed-structure fetched fine, but extraction yield collapsed vs. history
  -- error            transport failure, timeout, 5xx, non-HTML body
  -- unchanged        304, or byte-identical to the previous fetch
  status         TEXT NOT NULL CHECK (status IN ('ok','blocked','changed-structure','error','unchanged')),
  reason         TEXT,                          -- human-readable detail for non-ok statuses
  content_hash   TEXT,
  bytes          INTEGER,
  duration_ms    INTEGER,
  signals_found  INTEGER NOT NULL DEFAULT 0,    -- how many signals extracted non-null
  signals_expected INTEGER NOT NULL DEFAULT 0   -- how many we had a value for last time
) STRICT;

CREATE INDEX IF NOT EXISTS idx_fetches_company_time ON fetches(company_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_fetches_time ON fetches(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_fetches_status ON fetches(status, fetched_at DESC);

-- ---------------------------------------------------------------------------
-- observations -- APPEND ONLY. The time series.
--
-- One row per (company, signal) per successful extraction. `value` is the
-- canonical string form used for diffing; `value_json` carries structure for
-- composite signals (pricing tiers, logo lists, proof points).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observations (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fetch_id       INTEGER REFERENCES fetches(id) ON DELETE SET NULL,
  signal         TEXT NOT NULL,
  observed_at    TEXT NOT NULL,
  value          TEXT,                          -- NULL means "extractor found nothing this run"
  value_json     TEXT,
  value_hash     TEXT,                          -- FNV-1a of `value`; cheap equality
  method         TEXT,                          -- which strategy won, e.g. "h1", "og:title", "json-ld"
  confidence     REAL NOT NULL DEFAULT 1.0,     -- 0..1, lowers as we fall back to weaker strategies
  extractor_ver  TEXT NOT NULL
) STRICT;

-- The single most important index in the schema: "give me this company's
-- history for this signal, newest first".
CREATE INDEX IF NOT EXISTS idx_obs_series ON observations(company_id, signal, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(observed_at DESC);

-- ---------------------------------------------------------------------------
-- change_events -- the product
--
-- A row here is a claim we are making in public: "this company changed this
-- thing on this date". The bar for writing one is deliberately high. See
-- src/diff.js and METHODOLOGY.md.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS change_events (
  id                INTEGER PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id            INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  signal            TEXT NOT NULL,
  detected_at       TEXT NOT NULL,
  previous_seen_at  TEXT,                       -- when the old value was last observed
  before_value      TEXT,
  after_value       TEXT,
  before_json       TEXT,
  after_json        TEXT,
  -- added     first non-null value we have ever recorded for this signal
  -- modified  non-null -> different non-null
  -- removed   non-null -> confirmed absent (page fetched fine, other signals intact,
  --           and absence held for REMOVAL_CONFIRMATIONS consecutive runs)
  change_type       TEXT NOT NULL CHECK (change_type IN ('added','modified','removed')),
  magnitude         REAL,                       -- 0..1 normalised edit distance for text signals
  summary           TEXT,                       -- one-line human phrasing, precomputed for the feed
  UNIQUE (company_id, signal, detected_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_time ON change_events(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_company ON change_events(company_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_signal ON change_events(signal, detected_at DESC);

-- ---------------------------------------------------------------------------
-- signal_state -- derived current state + parser health counters
--
-- `consecutive_nulls` is what stops us reporting a broken selector as a
-- rebrand. `last_good_value` survives a null run so we can diff against the
-- last thing we actually believed, not against the gap.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signal_state (
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  signal             TEXT NOT NULL,
  last_observed_at   TEXT,                      -- last time we ran the extractor at all
  last_good_at       TEXT,                      -- last time it returned non-null
  last_good_value    TEXT,
  last_good_json     TEXT,
  last_good_hash     TEXT,
  last_good_method   TEXT,
  consecutive_nulls  INTEGER NOT NULL DEFAULT 0,
  suspect            INTEGER NOT NULL DEFAULT 0, -- 1 = we think our parser is broken, not their page
  total_changes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, signal)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_state_suspect ON signal_state(suspect, company_id);

-- ---------------------------------------------------------------------------
-- Convenience views
-- ---------------------------------------------------------------------------

-- Per-company health, as rendered on the public index.
CREATE VIEW IF NOT EXISTS v_company_health AS
SELECT
  c.id                AS company_id,
  c.slug,
  c.name,
  MAX(f.fetched_at)   AS last_attempt_at,
  MAX(CASE WHEN f.status IN ('ok','unchanged') THEN f.fetched_at END) AS last_ok_at,
  SUM(CASE WHEN f.status = 'ok' THEN 1 ELSE 0 END)                AS n_ok,
  SUM(CASE WHEN f.status = 'blocked' THEN 1 ELSE 0 END)           AS n_blocked,
  SUM(CASE WHEN f.status = 'error' THEN 1 ELSE 0 END)             AS n_error,
  SUM(CASE WHEN f.status = 'changed-structure' THEN 1 ELSE 0 END) AS n_structure
FROM companies c
LEFT JOIN fetches f ON f.company_id = c.id
GROUP BY c.id;

-- The public feed.
CREATE VIEW IF NOT EXISTS v_recent_changes AS
SELECT
  e.id, e.detected_at, e.signal, e.change_type, e.before_value, e.after_value,
  e.before_json, e.after_json, e.magnitude, e.summary, e.previous_seen_at,
  c.slug, c.name, c.segment
FROM change_events e
JOIN companies c ON c.id = e.company_id
ORDER BY e.detected_at DESC;
