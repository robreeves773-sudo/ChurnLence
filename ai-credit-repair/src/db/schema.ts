// SQLite schema for AI Credit Repair. All data lives on-device only.
// Migrations are applied in src/db/index.ts using PRAGMA user_version.

// Bump this when you add a new migration step below.
export const LATEST_SCHEMA_VERSION = 1;

// Each entry is run when migrating FROM that index. migrations[0] takes the
// database from version 0 (fresh) to version 1.
export const migrations: string[] = [
  // ---- v0 -> v1 : initial schema ----
  `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    uri        TEXT NOT NULL,
    bureau     TEXT,
    status     TEXT NOT NULL DEFAULT 'uploaded',
    notes      TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    creditor_name_normalized  TEXT,
    creditor_name             TEXT,
    original_creditor         TEXT,
    account_number_masked     TEXT,
    account_type              TEXT,
    date_opened               TEXT,
    created_at                INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS negative_items (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id              INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    document_id             INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    source                  TEXT NOT NULL,
    bureau                  TEXT,
    creditor_name           TEXT,
    original_creditor       TEXT,
    account_number_masked   TEXT,
    account_type            TEXT,
    item_category           TEXT,
    balance                 REAL,
    high_balance_or_limit   REAL,
    date_opened             TEXT,
    date_first_delinquency  TEXT,
    dofd_is_estimated       INTEGER NOT NULL DEFAULT 0,
    dofd_derivation         TEXT,
    estimated_removal_date  TEXT,
    charge_off_date         TEXT,
    date_last_activity      TEXT,
    status                  TEXT,
    payment_history         TEXT,
    confidence              TEXT,
    raw_notes               TEXT,
    confirmed               INTEGER NOT NULL DEFAULT 0,
    created_at              INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS advice (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id             INTEGER NOT NULL REFERENCES negative_items(id) ON DELETE CASCADE,
    recommended_action  TEXT NOT NULL,
    rationale           TEXT,
    llm_explanation     TEXT,
    created_at          INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS letters (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         INTEGER REFERENCES negative_items(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    recipient       TEXT,
    body_html       TEXT,
    pdf_uri         TEXT,
    mailed_at       INTEGER,
    mail_method     TEXT,
    tracking_number TEXT,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deadlines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    letter_id       INTEGER REFERENCES letters(id) ON DELETE CASCADE,
    item_id         INTEGER REFERENCES negative_items(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    start_at        INTEGER NOT NULL,
    due_at          INTEGER NOT NULL,
    notification_id TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS score_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    score      INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_account ON negative_items(account_id);
  CREATE INDEX IF NOT EXISTS idx_items_document ON negative_items(document_id);
  CREATE INDEX IF NOT EXISTS idx_deadlines_status ON deadlines(status);
  `,
];
