import Database from 'better-sqlite3'
import { copyFileSync, rmSync } from 'node:fs'

export type DB = Database.Database

// Content-addressed schema (plan doc 05): files -> contents (by SHA-256) -> chunks -> vectors.
// Status columns on files/contents act as the work queue.
export const MIGRATIONS: string[] = [
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

/** `migrations` is a parameter only so tests can add a failing one. */
export function openDatabase(path: string, migrations: string[] = MIGRATIONS): DB {
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    db.pragma('temp_store = MEMORY')
    migrate(db, path, migrations)
  } catch (err) {
    if (db.open) db.close()
    throw err
  }
  return db
}

/**
 * Plan doc 05 §10: an existing index is backed up with VACUUM INTO before migrating, and checked afterwards.
 * If any step fails, the backup is put back unchanged and DB_MIGRATION_FAILED is thrown.
 */
function migrate(db: DB, file: string, migrations: string[]): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > migrations.length) {
    throw Object.assign(new Error('Database was created by a newer version of Recall'), { code: 'DB_NEWER_VERSION' })
  }
  if (current === migrations.length) return
  const backup = current > 0 ? `${file}.pre-v${migrations.length}.bak` : undefined
  if (backup) {
    rmSync(backup, { force: true })
    db.prepare('VACUUM INTO ?').run(backup)
  }
  try {
    for (let v = current; v < migrations.length; v++) {
      db.transaction(() => {
        db.exec(migrations[v])
        db.pragma(`user_version = ${v + 1}`)
      })()
    }
    if (backup) {
      if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('quick_check failed after migration')
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('foreign key check failed after migration')
    }
  } catch (err) {
    if (!backup) throw err
    db.close()
    for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true })
    copyFileSync(backup, file)
    rmSync(backup, { force: true })
    throw Object.assign(new Error(`Could not update the index format: ${(err as Error).message}`), { code: 'DB_MIGRATION_FAILED' })
  }
  if (backup) rmSync(backup, { force: true })
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
  if (q("SELECT count(*) n FROM contents c WHERE extract_status = 'ok' AND chunk_count <> (SELECT count(*) FROM chunks WHERE content_id = c.id)"))
    problems.push('chunk count differs from chunks')
  if (q("SELECT count(*) n FROM chunks ch JOIN contents c ON c.id = ch.content_id LEFT JOIN chunk_vectors v ON v.chunk_id = ch.id WHERE c.embed_status = 'done' AND v.chunk_id IS NULL"))
    problems.push('content marked embedded has chunks without vectors')
  if (db.pragma('quick_check', { simple: true }) !== 'ok') problems.push('SQLite quick_check failed')
  if ((db.pragma('foreign_key_check') as unknown[]).length) problems.push('foreign key violation')
  for (const table of ['chunks_fts', 'files_fts']) {
    try {
      db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1)`).run()
    } catch {
      problems.push(`${table} integrity-check failed`)
    }
  }
  if (problems.length) throw new Error('Index inconsistent: ' + problems.join('; '))
}
