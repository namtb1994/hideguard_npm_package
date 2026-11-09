// Test-only native adapter: no Node/SQLite import is included in the published runtime.
import { DatabaseSync } from 'node:sqlite';

export function sqliteStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=10000');
  db.exec('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL)');
  const get = db.prepare('SELECT version, value, expiresAt FROM records WHERE key=?');
  const insert = db.prepare('INSERT INTO records(key, version, value, expiresAt) VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING');
  const replace = db.prepare('UPDATE records SET version=?, value=?, expiresAt=? WHERE key=? AND version=?');
  const scan = db.prepare('SELECT key, version, expiresAt FROM records WHERE key>? AND expiresAt>0 AND expiresAt<? ORDER BY key LIMIT ?');
  const remove = db.prepare('DELETE FROM records WHERE key=? AND version=? AND expiresAt>0 AND expiresAt<?');
  const view = {
    async read(key) {const row = get.get(key); return row ? {...row, value: JSON.parse(row.value)} : null;},
    async insert(key, row) {return insert.run(key, row.version, JSON.stringify(row.value), row.expiresAt).changes === 1;},
    async replace(key, version, row) {return replace.run(row.version, JSON.stringify(row.value), row.expiresAt, key, version).changes === 1;},
  };
  return {
    ...view,
    async scanExpired({before, limit, cursor}) {
      const candidates = scan.all(cursor ?? '', before, limit + 1);
      const records = candidates.slice(0, limit);
      return {records, nextCursor: candidates.length > limit ? records.at(-1).key : null};
    },
    async removeExpired(key, expectedVersion, before) {return remove.run(key, expectedVersion, before).changes === 1;},
    async transaction(operation) {
      db.exec('BEGIN IMMEDIATE');
      try {const result = await operation(view); db.exec('COMMIT'); return result;}
      catch (error) {db.exec('ROLLBACK'); throw error;}
    },
    close() {db.close();},
  };
}
