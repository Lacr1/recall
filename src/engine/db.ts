import Database from 'better-sqlite3'

export type DB = Database.Database

// Content-addressed schema (plan doc 05): files -> contents (by SHA-256) -> chunks -> vectors.
// Status columns on files/contents act as the work queue.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','unavailable')),
    scan_generation INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    last_scan_completed_at INTEGER
  );

  CREATE TABLE contents (
    id INTEGER PRIMARY KEY,
    sha256 TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    extract_status TEXT NOT NULL DEFAULT 'pending',
    extract_error TEXT,
    extract_attempts INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    page_count INTEGER,
    char_count INTEGER,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    embed_status TEXT NOT NULL DEFAULT 'pending',
    orphaned_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (sha256, kind)
  );
  CREATE INDEX idx_contents_extract ON contents(extract_status);
  CREATE INDEX idx_contents_embed ON contents(embed_status);
  CREATE INDEX idx_contents_orphaned ON contents(orphaned_at);

  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    rel_path TEXT NOT NULL,
    path_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    name_tokens TEXT NOT NULL,
    path_tokens TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    content_id INTEGER REFERENCES contents(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','skipped','error')),
    skip_reason TEXT,
    error_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    seen_generation INTEGER NOT NULL
  );
  CREATE INDEX idx_files_folder ON files(folder_id, status);
  CREATE INDEX idx_files_content ON files(content_id);
  CREATE INDEX idx_files_status ON files(status);

  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    page_start INTEGER,
    page_end INTEGER,
    section_path TEXT,
    UNIQUE (content_id, ord)
  );

  CREATE TABLE chunk_vectors (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    vec BLOB NOT NULL
  );

  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text, content='chunks', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;

  CREATE VIRTUAL TABLE files_fts USING fts5(
    name_tokens, path_tokens, content='files', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, name_tokens, path_tokens) VALUES (new.id, new.name_tokens, new.path_tokens);
  END;
  CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name_tokens, path_tokens) VALUES ('delete', old.id, old.name_tokens, old.path_tokens);
  END;
  CREATE TRIGGER files_au AFTER UPDATE OF name_tokens, path_tokens ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name_tokens, path_tokens) VALUES ('delete', old.id, old.name_tokens, old.path_tokens);
    INSERT INTO files_fts(rowid, name_tokens, path_tokens) VALUES (new.id, new.name_tokens, new.path_tokens);
  END;

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `
]

export function openDatabase(path: string): DB {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('temp_store = MEMORY')
  migrate(db)
  return db
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > MIGRATIONS.length) {
    throw Object.assign(new Error('Database was created by a newer version of Recall'), { code: 'DB_NEWER_VERSION' })
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Invariants that must hold after any sequence of operations (used by tests). */
export function assertIndexConsistent(db: DB): void {
  const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  const problems: string[] = []
  if (q('SELECT count(*) n FROM chunk_vectors v LEFT JOIN chunks c ON c.id = v.chunk_id WHERE c.id IS NULL'))
    problems.push('vector without chunk')
  if (q('SELECT count(*) n FROM chunks c LEFT JOIN contents t ON t.id = c.content_id WHERE t.id IS NULL'))
    problems.push('chunk without content')
  if (q('SELECT count(*) n FROM chunks') !== q("SELECT count(*) n FROM chunks_fts"))
    problems.push('FTS row count differs from chunk count')
  if (q("SELECT count(*) n FROM files WHERE status = 'linked' AND content_id IS NULL"))
    problems.push('linked file without content')
  const integrity = db.prepare("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)")
  try {
    integrity.run()
  } catch {
    problems.push('chunks_fts integrity-check failed')
  }
  if (problems.length) throw new Error('Index inconsistent: ' + problems.join('; '))
}
