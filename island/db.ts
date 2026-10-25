import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, addDays, splitCapacity, today, type Seed, type SeedIsland } from '../shared/config.ts';

export type Db = DatabaseSync;

export function openDb(islandId: string): Db {
  const dir = join(ROOT, 'data');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `island-${islandId}.db`));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, location TEXT NOT NULL,
      description TEXT NOT NULL, price_php INTEGER NOT NULL, facilities TEXT NOT NULL, image TEXT
    );

    -- The WALK-IN pool. This island is its only writer.
    CREATE TABLE IF NOT EXISTS inventory (
      listing_id TEXT NOT NULL, day TEXT NOT NULL,
      available INTEGER NOT NULL CHECK (available >= 0),
      PRIMARY KEY (listing_id, day)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      request_id TEXT UNIQUE,                      -- idempotency key (walk-ins)
      source TEXT NOT NULL CHECK (source IN ('WALKIN', 'ONLINE')),
      listing_id TEXT NOT NULL, day TEXT NOT NULL,
      nights INTEGER NOT NULL, qty INTEGER NOT NULL,
      guest_name TEXT NOT NULL, id_type TEXT NOT NULL, id_last4 TEXT NOT NULL,
      total_php INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      created_at INTEGER NOT NULL, redeemed_at INTEGER
    );

    -- Written in the same transaction as the change it describes; drained to central.
    CREATE TABLE IF NOT EXISTS outbox (
      event_id TEXT PRIMARY KEY, type TEXT NOT NULL, booking_id TEXT,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER
    );
  `);
  return db;
}

export function seedIsland(db: Db, seed: Seed, island: SeedIsland): void {
  const insertListing = db.prepare(
    `INSERT OR IGNORE INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDay = db.prepare(`INSERT OR IGNORE INTO inventory VALUES (?, ?, ?)`);
  const start = today();
  db.exec('BEGIN');
  for (const l of island.listings) {
    insertListing.run(l.id, l.kind, l.name, l.location, l.description, l.pricePhp,
      JSON.stringify(l.facilities), l.image);
    const { walkin } = splitCapacity(l.capacity, seed.onlineShare);
    for (let i = 0; i < seed.inventoryDays; i++) insertDay.run(l.id, addDays(start, i), walkin);
  }
  db.exec('COMMIT');
}

// Runs fn inside BEGIN IMMEDIATE so concurrent writers (other processes on the
// same file, e.g. the load test) queue on the write lock instead of interleaving.
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function addOutbox(db: Db, type: string, bookingId: string | null, payload: unknown): void {
  db.prepare(`INSERT INTO outbox (event_id, type, booking_id, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(randomUUID(), type, bookingId, JSON.stringify(payload), Date.now());
}
