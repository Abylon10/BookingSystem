/**
 * island/db.ts
 *
 * The island's local database (built-in node:sqlite, one file per island in
 * data/). It holds everything the island OWNS and needs while offline:
 *  - listings   : catalog of this island's resort and tour
 *  - inventory  : the WALK-IN pool, units left per listing per day
 *  - bookings   : walk-in bookings sold here + online bookings it was told about
 *  - outbox     : events waiting to be sent to central
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, addDays, splitCapacity, today, type Seed, type SeedIsland } from '../shared/config.ts';

export type Db = DatabaseSync;

// Shape of a row in the bookings table (column names as in SQL).
export interface BookingRow {
  id: string;
  request_id: string | null;
  source: 'WALKIN' | 'ONLINE';
  listing_id: string;
  day: string;
  nights: number;
  qty: number;
  guest_name: string;
  id_type: string;
  id_last4: string;
  total_php: number;
  code: string;
  status: 'CONFIRMED' | 'REDEEMED' | 'CANCELLED' | 'NO_SHOW';
  created_at: number;
  redeemed_at: number | null;
}

// Opens (or creates) data/island-<id>.db and makes sure all tables exist.
export function openDb(islandId: string): Db {
  // data/ is git-ignored; create it on first run.
  const dir = join(ROOT, 'data');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `island-${islandId}.db`));

  // Schema. CREATE TABLE IF NOT EXISTS makes this safe to run on every start.
  db.exec(`
    -- WAL lets readers (the console refreshing) run while a booking is written.
    -- busy_timeout makes a second writer wait up to 5 s instead of failing.
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    -- Catalog copy for this island. facilities is a JSON array string.
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, location TEXT NOT NULL,
      description TEXT NOT NULL, price_php INTEGER NOT NULL, facilities TEXT NOT NULL, image TEXT
    );

    -- The WALK-IN pool: units left per listing per day. This island is the only
    -- writer. The CHECK makes a negative count impossible even if code is wrong.
    CREATE TABLE IF NOT EXISTS inventory (
      listing_id TEXT NOT NULL, day TEXT NOT NULL,
      available INTEGER NOT NULL CHECK (available >= 0),
      PRIMARY KEY (listing_id, day)
    );

    -- Bookings this island knows about.
    --   source WALKIN : sold at this desk (request_id = idempotency key)
    --   source ONLINE : sold by central, registered here for check-in
    -- code is UNIQUE so two bookings can never share a ticket code.
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      request_id TEXT UNIQUE,
      source TEXT NOT NULL CHECK (source IN ('WALKIN', 'ONLINE')),
      listing_id TEXT NOT NULL, day TEXT NOT NULL,
      nights INTEGER NOT NULL, qty INTEGER NOT NULL,
      guest_name TEXT NOT NULL, id_type TEXT NOT NULL, id_last4 TEXT NOT NULL,
      total_php INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      created_at INTEGER NOT NULL, redeemed_at INTEGER
    );

    -- Outbox pattern: each change also writes an event row in the SAME
    -- transaction, so the change and "tell central about it" can never get out
    -- of step. sent_at stays NULL until central acknowledges the event.
    CREATE TABLE IF NOT EXISTS outbox (
      event_id TEXT PRIMARY KEY, type TEXT NOT NULL, booking_id TEXT,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER
    );
  `);
  return db;
}

// Fills listings and the walk-in pool from config/seed.json. INSERT OR IGNORE
// means existing rows (and units already sold) are never overwritten, so this
// runs safely on every start and only adds missing days.
export function seedIsland(db: Db, seed: Seed, island: SeedIsland): void {
  const insertListing = db.prepare(`INSERT OR IGNORE INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertDay = db.prepare(`INSERT OR IGNORE INTO inventory VALUES (?, ?, ?)`);
  const start = today();

  // One transaction for all rows: much faster than hundreds of separate commits.
  transaction(db, () => {
    for (const l of island.listings) {
      insertListing.run(l.id, l.kind, l.name, l.location, l.description, l.pricePhp,
        JSON.stringify(l.facilities), l.image);

      // Only the walk-in share goes here; the online share lives in Supabase.
      const { walkin } = splitCapacity(l.capacity, seed.onlineShare);
      for (let i = 0; i < seed.inventoryDays; i++) insertDay.run(l.id, addDays(start, i), walkin);
    }
  });
}

// Runs `fn` inside a transaction and commits, or rolls back if it throws.
// BEGIN IMMEDIATE takes the write lock up front, so two writers (for example
// the server and a second process on the same file) queue up instead of
// interleaving their reads and writes.
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

// Adds an event to the outbox. Must be called inside the same transaction as
// the change it describes (see the outbox table comment above).
export function addOutbox(db: Db, type: string, bookingId: string | null, payload: unknown): void {
  db.prepare(`INSERT INTO outbox (event_id, type, booking_id, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(randomUUID(), type, bookingId, JSON.stringify(payload), Date.now());
}

// Reads one booking by id, typed. Returns undefined when it does not exist.
export function getBooking(db: Db, id: string): BookingRow | undefined {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as BookingRow | undefined;
}
