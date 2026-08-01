-- Esquema do coletor de uso de tokens de IA do Cockpit.
-- Escrito por um único worker (WAL permite leitores concorrentes em readOnly).

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Cursor de leitura por arquivo JSONL.
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY,
  path        TEXT    NOT NULL UNIQUE,
  provider    TEXT    NOT NULL,
  root_tag    TEXT    NOT NULL,
  ino         TEXT,                          -- "dev:ino"; muda quando o arquivo é recriado
  size        INTEGER NOT NULL DEFAULT 0,
  mtime_ms    INTEGER NOT NULL DEFAULT 0,
  offset      INTEGER NOT NULL DEFAULT 0,    -- bytes consumidos, sempre logo após um '\n'
  head_sig    TEXT,                          -- sha1 dos 1ºs 4 KiB: pega reescrita que preserva o inode
  cursor_json TEXT,                          -- estado de carry por provider (Codex: prev/model/cwd/uuid)
  state       TEXT    NOT NULL DEFAULT 'active',  -- active | missing | error
  bad_lines   INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_scan ON files(state, mtime_ms);

-- Grão fino: uma linha por requisição faturável, após dedup.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  event_key  TEXT    NOT NULL,
  provider   TEXT    NOT NULL,
  model      TEXT    NOT NULL,
  ts_ms      INTEGER NOT NULL,
  hour_utc   INTEGER NOT NULL,               -- floor(ts_ms / 3600000)
  project_id TEXT    NOT NULL DEFAULT '__none__',
  cwd        TEXT,
  session_id TEXT,
  file_id    INTEGER REFERENCES files(id) ON DELETE SET NULL,

  -- contadores faturáveis, mutuamente exclusivos
  input_tokens          INTEGER NOT NULL DEFAULT 0,  -- input não-cacheado
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,  -- já inclui reasoning
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,  -- informativo; subconjunto de output

  cost_usd     REAL,                          -- NULL = sem preço conhecido (nunca 0 falso)
  price_source TEXT    NOT NULL DEFAULT 'unknown',
  price_rev    INTEGER NOT NULL DEFAULT 0,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS events_key ON events(event_key);
CREATE INDEX IF NOT EXISTS events_rollup ON events(hour_utc, project_id, provider, model);
CREATE INDEX IF NOT EXISTS events_project_ts ON events(project_id, ts_ms DESC);
CREATE INDEX IF NOT EXISTS events_unpriced ON events(model) WHERE cost_usd IS NULL;

-- Rollup horário. Também é a fila de envio: pendente == synced_hash IS NULL OR <> payload_hash.
CREATE TABLE IF NOT EXISTS hourly (
  hour_utc   INTEGER NOT NULL,
  project_id TEXT    NOT NULL,
  provider   TEXT    NOT NULL,
  model      TEXT    NOT NULL,

  requests              INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL    NOT NULL DEFAULT 0,
  unpriced_requests     INTEGER NOT NULL DEFAULT 0,

  payload_hash TEXT NOT NULL,
  synced_hash  TEXT,
  synced_at    INTEGER,
  fail_count   INTEGER NOT NULL DEFAULT 0,   -- quarentena após N rejeições
  updated_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_utc, project_id, provider, model)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS hourly_outbox ON hourly(hour_utc)
  WHERE synced_hash IS NULL OR synced_hash <> payload_hash;

-- Buckets que precisam ser recomputados a partir de events.
CREATE TABLE IF NOT EXISTS dirty_hours (
  hour_utc   INTEGER NOT NULL,
  project_id TEXT    NOT NULL,
  provider   TEXT    NOT NULL,
  model      TEXT    NOT NULL,
  PRIMARY KEY (hour_utc, project_id, provider, model)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at      INTEGER,
  last_success_at      INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT
);
INSERT OR IGNORE INTO sync_state (id) VALUES (1);

-- Preços em USD por token (não por milhão).
CREATE TABLE IF NOT EXISTS model_prices (
  model               TEXT PRIMARY KEY,
  provider            TEXT,
  input_cost          REAL,
  output_cost         REAL,
  cache_read_cost     REAL,
  cache_write_5m_cost REAL,
  cache_write_1h_cost REAL,
  source              TEXT    NOT NULL,      -- litellm | override | fallback
  rev                 INTEGER NOT NULL DEFAULT 0,
  fetched_at          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS model_alias (
  raw   TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  note  TEXT
);

-- Projetos descobertos pelo `cwd` que não estão cadastrados no Cockpit.
-- Sem isto a maior parte do consumo cairia em '__none__': medido nesta máquina,
-- 83 mil de 147 mil eventos vinham de repositórios fora do projects.json.
-- O id sempre começa com '~' — prefixo que os ids do Cockpit nunca usam, o que
-- torna trivial promover o bucket quando o projeto for cadastrado de verdade.
CREATE TABLE IF NOT EXISTS derived_projects (
  project_id TEXT PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
