import * as SQLite from 'expo-sqlite';
import { LATEST_SCHEMA_VERSION, migrations } from './schema';

const DB_NAME = 'aicreditrepair.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

// Opens (once) and migrates the on-device database. Safe to call repeatedly.
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openAndMigrate();
  }
  return dbPromise;
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version;'
  );
  let version = row?.user_version ?? 0;

  while (version < LATEST_SCHEMA_VERSION) {
    const migration = migrations[version];
    await db.execAsync(migration);
    version += 1;
    // user_version can't be parameterized; version is an internal integer.
    await db.execAsync(`PRAGMA user_version = ${version};`);
  }

  return db;
}

// Wipe all on-device data (keeps the schema). Used by Settings "Wipe all data".
export async function wipeAllData(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    DELETE FROM deadlines;
    DELETE FROM letters;
    DELETE FROM advice;
    DELETE FROM negative_items;
    DELETE FROM accounts;
    DELETE FROM documents;
    DELETE FROM score_log;
    DELETE FROM settings;
  `);
}
