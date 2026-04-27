/**
 * SQLite registry that owns globally-unique nickname assignments.
 *
 * Schema (single table, no migrations needed yet):
 *
 *   nicknames (
 *     address      TEXT PRIMARY KEY,   -- base58 wallet pubkey
 *     nickname     TEXT UNIQUE NOT NULL,
 *     algorithm    INTEGER NOT NULL,    -- algorithm version this row was assigned under
 *     assigned_at  INTEGER NOT NULL     -- unix epoch ms
 *   );
 *
 * The `UNIQUE` constraint on `nickname` is the load-bearing global
 * uniqueness invariant. Concurrent registrations of distinct addresses
 * that both target the same first-choice nickname race against the
 * constraint — the loser catches `SQLITE_CONSTRAINT_UNIQUE` and
 * advances to the next probe candidate.
 *
 * The `algorithm` column captures which version of the assignment
 * algorithm + word lists produced the row. Bumping
 * `NICKNAME_ALGORITHM_VERSION` (e.g. when the word lists change)
 * means freshly-derived candidates would no longer match the historical
 * probe sequence; mixing versions in the same DB is forbidden. The
 * boot-time invariant (`assertSchemaInvariants`) fails fast if it sees
 * any row from a different version — operators must migrate or wipe.
 *
 * Storage footprint: ~80 bytes per row (PRIMARY KEY index +
 * UNIQUE index doubles that effective on disk). 1M users ≈ 160 MB.
 * On tucker, `nicknames.db` lives at the bind-mounted path so it
 * survives container restarts.
 */

import Database from "better-sqlite3";

/**
 * Algorithm version. **Bump if any of the following changes:**
 *  - The word lists in `words.ts` (additions, removals, or reorderings).
 *  - The hash function or the way bytes are extracted (in `assign.ts`).
 *  - The probe sequence (e.g. switching from sequential to a different ordering).
 *
 * **Do NOT bump for**: cosmetic doc updates, banned-word list additions
 * that don't remove existing list entries, or test-only changes.
 *
 * Bumping forces an operator decision: the existing rows can either be
 * preserved (display names stay stable for existing users; no new
 * algorithm-version migration is performed) or wiped (everyone gets a
 * fresh assignment, breaking continuity). Both have a cost; the
 * `assertSchemaInvariants` check below makes the operator pick
 * deliberately rather than letting the DB silently drift.
 */
export const NICKNAME_ALGORITHM_VERSION = 1;

export interface NicknameRow {
  address: string;
  algorithm: number;
  assigned_at: number;
  nickname: string;
}

export type NicknameDb = Database.Database;

/**
 * Open the SQLite file at `path`, create the table if missing, and
 * verify schema invariants. Returns a ready-to-use database handle.
 *
 * The handle is configured with WAL mode (concurrent reads + a single
 * writer never block each other; better fit for the read-heavy lookup
 * workload than the default rollback-journal mode).
 */
export function openNicknameDb(path: string): NicknameDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // synchronous=FULL (not NORMAL): the registry's load-bearing
  // property is "permanent assignment" — a row lost to a power-loss
  // / kernel-panic race between INSERT and the next WAL checkpoint
  // would re-issue the nickname to a different address on retry,
  // violating global uniqueness from the user's perspective. FULL
  // costs one extra fsync per write; at this volume (registrations
  // are a tiny fraction of one mint) the cost is negligible.
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");

  // CREATE TABLE IF NOT EXISTS keeps the existing schema if columns
  // ever change, which is intentional for v1: there is no in-place
  // migration story yet. When NICKNAME_ALGORITHM_VERSION is bumped,
  // the operator runbook must spell out either "wipe and re-derive
  // (loses continuity)" or "write a migration that re-derives stale
  // rows under the new algorithm." Until that runbook exists, bumping
  // the version is a one-way door.
  db.exec(`
    CREATE TABLE IF NOT EXISTS nicknames (
      address TEXT PRIMARY KEY,
      nickname TEXT NOT NULL UNIQUE,
      algorithm INTEGER NOT NULL,
      assigned_at INTEGER NOT NULL
    );
  `);

  return db;
}

/**
 * Assert two invariants on boot:
 *   1. Every nickname is unique (UNIQUE schema constraint).
 *   2. Every row was assigned under the current algorithm version.
 *
 * Either failing means the operator must intervene. Throws a precise
 * error so the index.ts startup banner can `process.exit(1)` with a
 * helpful message rather than letting the service start in an
 * inconsistent state.
 */
export function assertSchemaInvariants(db: NicknameDb): void {
  // SELECT COUNT(*) on a present-and-opened SQLite handle always
  // returns one row; if it doesn't, the handle is broken in a way no
  // defensive check could recover from, so we throw and let the
  // operator triage.
  const dupeRow = db
    .prepare<[], { dupes: number }>(
      "SELECT COUNT(*) - COUNT(DISTINCT nickname) AS dupes FROM nicknames"
    )
    .get();
  if (dupeRow === undefined) {
    throw new Error(
      "nicknames db: COUNT query unexpectedly returned no rows. Investigate the DB handle before serving traffic."
    );
  }
  const { dupes } = dupeRow;
  if (dupes !== 0) {
    throw new Error(
      `nicknames db: ${dupes} duplicate nickname(s) detected. The UNIQUE constraint should make this impossible — investigate before serving traffic.`
    );
  }

  const versionCheck = db
    .prepare<[number], { count: number }>(
      "SELECT COUNT(*) AS count FROM nicknames WHERE algorithm != ?"
    )
    .get(NICKNAME_ALGORITHM_VERSION);
  if (versionCheck && versionCheck.count > 0) {
    throw new Error(
      `nicknames db: ${versionCheck.count} row(s) assigned under a different algorithm version (current=${NICKNAME_ALGORITHM_VERSION}). Mixing versions silently drifts the registry. To proceed, either reset the DB (lose all assignments) or write a migration that re-derives stale rows.`
    );
  }
}

/**
 * Returns the row count. Used by the boot banner and the health
 * endpoint so operators can see at a glance whether the registry is
 * populated (a "wait, why is it 0?" surprise after a restart with a
 * missing bind-mount is exactly the failure mode we want to be loud
 * about).
 */
export function countNicknames(db: NicknameDb): number {
  const row = db
    .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM nicknames")
    .get();
  return row?.count ?? 0;
}
