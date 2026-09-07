import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite persistence, using Node's built-in `node:sqlite` (no native build step).
 *
 * Three tables, each with a distinct job:
 *   processed_messages — idempotency ledger, one row per (message, workflow)
 *   workflow_runs      — one row per execution attempt
 *   audit_events       — one row per external side effect that was performed
 */

export type Database = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_messages (
  gmail_message_id     TEXT NOT NULL,
  workflow_id          TEXT NOT NULL,
  billing_period       TEXT,
  artifact_filename    TEXT,
  artifact_sha256      TEXT,
  status               TEXT NOT NULL,
  outgoing_message_id  TEXT,
  error                TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  dry_run              INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (gmail_message_id, workflow_id)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id       TEXT NOT NULL,
  gmail_message_id  TEXT,
  trigger_source    TEXT NOT NULL,
  status            TEXT NOT NULL,
  stage             TEXT,
  error             TEXT,
  dry_run           INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT NOT NULL,
  finished_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs (workflow_id, started_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    INTEGER,
  at        TEXT NOT NULL,
  action    TEXT NOT NULL,
  target    TEXT,
  detail    TEXT,
  dry_run   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events (run_id);
`;

export function openDatabase(dbPath: string): Database {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  if (dbPath !== ':memory:') {
    // The ledger records what was billed and where it was sent — keep it private.
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // Best effort; not fatal on filesystems that do not support chmod.
    }
  }
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
