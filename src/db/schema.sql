-- Slop Swarm token probe (plan §10). The controller is the only writer of every table
-- except `controls`, which the CLI and dashboard append to and the controller consumes.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A world: a forge plus the agents' homes (docs/plans/2026-10-12-hosted-control-plane.md §3). A run is a
-- time-boxed session in one world; runs from before worlds became worlds of the same id.
CREATE TABLE IF NOT EXISTS worlds (
  id            TEXT PRIMARY KEY,           -- also the forge's hostname part (slopswarm-forge-<id>)
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  forge_image   TEXT NOT NULL,              -- the Forgejo image its forge last ran (upgrades run its migrations)
  status        TEXT NOT NULL DEFAULT 'idle',  -- idle | active (a run is in it) | archived
  forge_port    INTEGER                     -- the host port of its forge (stable per world on the VPS)
);

-- Per world and agent: what carries over between runs. `agents` rows stay per run.
CREATE TABLE IF NOT EXISTS world_agents (
  world_id        TEXT NOT NULL REFERENCES worlds(id),
  name            TEXT NOT NULL,
  harness         TEXT NOT NULL,
  last_session_id TEXT,
  continue_next   INTEGER NOT NULL DEFAULT 0,
  home_generation INTEGER NOT NULL DEFAULT 0,   -- the VPS backup copy's generation (0 = none yet)
  added_at        INTEGER NOT NULL,
  removed_at      INTEGER,                      -- left the world (between runs); its home is kept
  PRIMARY KEY (world_id, name)
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,           -- e.g. 20261010-1200-tiny-society-A
  name          TEXT NOT NULL,
  world_id      TEXT,                       -- the world it ran in (worlds.id)
  brief         TEXT,                       -- optional run brief, added to each agent's first wake note
  host_hash     TEXT,                       -- hash of the allowlist and limits the runner applied (hostconfig.ts)
  config_yaml   TEXT NOT NULL,              -- swarm + agent YAML snapshot
  seed_sha256   TEXT NOT NULL,
  seed_text     TEXT NOT NULL,
  pricing_yaml  TEXT NOT NULL,
  cli_versions  TEXT,                       -- JSON {"claude": "...", "codex": "..."}
  image_digest  TEXT,
  status        TEXT NOT NULL DEFAULT 'running',   -- running | stopping | stopped | finished
  stop_reason   TEXT,
  started_at    INTEGER NOT NULL,           -- unix ms
  deadline_at   INTEGER NOT NULL,           -- started_at + max_duration
  ended_at      INTEGER
);

CREATE TABLE IF NOT EXISTS agents (
  run_id          TEXT NOT NULL REFERENCES runs(id),
  name            TEXT NOT NULL,
  harness         TEXT NOT NULL,            -- claude | codex | pi
  model           TEXT NOT NULL,
  effort          TEXT NOT NULL,
  budget_usd      REAL NOT NULL,
  spent_usd       REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,            -- active | sleeping | waking | paused | depleted | failed
  next_wake_at    INTEGER,                  -- unix ms; NULL = not scheduled
  next_trigger    TEXT,                     -- initial | self | timer | message | manual
  continue_next   INTEGER NOT NULL DEFAULT 0,  -- agent asked continue_session: true
  last_session_id TEXT,
  last_wake_end   INTEGER,
  wake_count      INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, name)
);

CREATE TABLE IF NOT EXISTS wakes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  agent           TEXT NOT NULL,
  seq             INTEGER NOT NULL,         -- 1-based wake number for this agent
  trigger         TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  slept_ms        INTEGER,                  -- time since the previous wake ended (NULL for first)
  exit_reason     TEXT,
  exit_code       INTEGER,
  turns           INTEGER,
  resumed         INTEGER NOT NULL DEFAULT 0,
  session_id      TEXT,
  cost_usd        REAL NOT NULL DEFAULT 0,
  reported_cost_usd REAL,                   -- vendor-reported (Claude total_cost_usd, OpenRouter's summed charges), cross-check
  requests        INTEGER NOT NULL DEFAULT 0,
  fresh_input     INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  cache_write_5m  INTEGER NOT NULL DEFAULT 0,
  cache_write_1h  INTEGER NOT NULL DEFAULT 0,
  output          INTEGER NOT NULL DEFAULT 0,
  reasoning       INTEGER NOT NULL DEFAULT 0,
  web_searches    INTEGER NOT NULL DEFAULT 0,
  tool_calls      INTEGER NOT NULL DEFAULT 0,
  home_bytes      INTEGER,
  msgs_in         INTEGER NOT NULL DEFAULT 0,  -- unread forge notifications at wake start
  next_in_minutes REAL,                     -- what the agent asked for (NULL = no next_wake.yaml)
  continue_requested INTEGER,
  raw_log_path    TEXT,
  container_name  TEXT
);
CREATE INDEX IF NOT EXISTS wakes_run_agent ON wakes(run_id, agent, seq);

CREATE TABLE IF NOT EXISTS requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wake_id         INTEGER NOT NULL REFERENCES wakes(id),
  run_id          TEXT NOT NULL,
  agent           TEXT NOT NULL,
  seq             INTEGER NOT NULL,         -- order within the wake
  request_id      TEXT NOT NULL,
  model           TEXT NOT NULL,
  ts              TEXT,
  fresh_input     INTEGER NOT NULL,
  cache_read      INTEGER NOT NULL,
  cache_write_5m  INTEGER NOT NULL,
  cache_write_1h  INTEGER NOT NULL,
  output          INTEGER NOT NULL,
  reasoning       INTEGER NOT NULL,
  web_searches    INTEGER NOT NULL,
  prompt_tokens   INTEGER NOT NULL,
  tier            INTEGER NOT NULL,         -- 0 = base, else the threshold applied
  cost_usd        REAL NOT NULL,
  vendor_cost_usd REAL,                     -- what the vendor charged (OpenRouter generation lookup), cross-check
  vendor_provider TEXT,                     -- who served it (OpenRouter's provider_name)
  UNIQUE (wake_id, request_id)
);
CREATE INDEX IF NOT EXISTS requests_run_agent ON requests(run_id, agent);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL,
  agent     TEXT,                           -- NULL for run-level events
  wake_id   INTEGER,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,                  -- tool_call | tool_result | lifecycle | control | error
  name      TEXT,                           -- tool name / lifecycle step
  detail    TEXT,                           -- short args / summary
  ok        INTEGER
);
CREATE INDEX IF NOT EXISTS events_run_ts ON events(run_id, ts);

-- Control queue written by `just pause/unpause/wake/stop` and the dashboard; consumed by the controller.
CREATE TABLE IF NOT EXISTS controls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT,                         -- NULL for launch
  agent       TEXT,
  action      TEXT NOT NULL,                -- pause | unpause | wake | stop | kill | extend | launch (run_id NULL)
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  source      TEXT,                         -- cli | dashboard | api
  detail      TEXT,                         -- JSON arguments (extend, launch)
  result      TEXT                          -- JSON outcome of a launch: {"run": id} or {"error": "…"}
);

-- More world time and/or budget for a run (`just extend`), applied by the controller. The record of every
-- extension and the source of the effective swarm budget (snapshot value + the sum of swarm_usd here).
CREATE TABLE IF NOT EXISTS extensions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(id),
  ts             INTEGER NOT NULL,
  source         TEXT,
  time_ms        INTEGER NOT NULL DEFAULT 0,
  old_deadline   INTEGER NOT NULL,
  new_deadline   INTEGER NOT NULL,
  swarm_usd      REAL NOT NULL DEFAULT 0,
  agent_usd_json TEXT NOT NULL DEFAULT '{}'  -- {"*": every agent, "<name>": that agent}; the flags add up
);

-- Config in the DB (docs/plans/2026-10-12-hosted-control-plane.md §4): editable without a redeploy. Each holds YAML
-- (or the seed's text) validated on save by the config parsers; config/ in git is the default set loaded into an
-- empty DB (`just config export|import` syncs files and DB). Every run still freezes a snapshot (runs.config_yaml,
-- seed_text, pricing_yaml).
CREATE TABLE IF NOT EXISTS seeds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,   -- the version
  name        TEXT NOT NULL DEFAULT 'default',     -- the seed (presets pick one by name); versions are per name
  text        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0           -- exactly one active per name
);
CREATE TABLE IF NOT EXISTS agent_profiles (
  name        TEXT PRIMARY KEY,
  yaml        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS swarm_presets (
  name        TEXT PRIMARY KEY,
  yaml        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
