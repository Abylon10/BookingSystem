import { randomUUID } from 'node:crypto';
import { addDays } from '../shared/config.ts';
import { isValidCode, newCode, signTicket, verifyTicket, type TicketPayload } from '../shared/ticket.ts';
import { addOutbox, transaction, type Db } from './db.ts';

export class BookingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface WalkinRequest {
  requestId: string;
  listingId: string;
  day: string;
  nights?: number;
  qty: number;
  guestName: string;
  idType: string;
  idLast4: string;
}

interface BookingRow {
  id: string;
  source: string;
  listing_id: string;
  day: string;
  nights: number;
  qty: number;
  guest_name: string;
  id_type: string;
  id_last4: string;
  total_php: number;
  code: string;
  status: string;
  redeemed_at: number | null;
}

export function ticketFor(secret: string, b: BookingRow): { code: string; qr: string } {
  const payload: TicketPayload = {
    v: 1, id: b.id, code: b.code, listing: b.listing_id, day: b.day, nights: b.nights,
    qty: b.qty, guest: b.guest_name, idType: b.id_type, idLast4: b.id_last4,
  };
  return { code: b.code, qr: signTicket(secret, payload) };
}

export function bookWalkin(db: Db, secret: string, req: WalkinRequest) {
  const nights = req.nights ?? 1;
  if (!/^\d{4}$/.test(req.idLast4)) throw new BookingError(400, 'idLast4 must be 4 digits');
  if (req.qty < 1 || nights < 1) throw new BookingError(400, 'qty and nights must be >= 1');

  const existing = db.prepare('SELECT * FROM bookings WHERE request_id = ?').get(req.requestId) as
    BookingRow | undefined;
  if (existing) return existing; // retried request

  const listing = db.prepare('SELECT price_php FROM listings WHERE id = ?').get(req.listingId) as
    { price_php: number } | undefined;
  if (!listing) throw new BookingError(404, 'Unknown listing for this island');

  const take = db.prepare(
    'UPDATE inventory SET available = available - ? WHERE listing_id = ? AND day = ? AND available >= ?',
  );
  return transaction(db, () => {
    // The WHERE available >= ? guard is the whole race fix: two desks selling the
    // last room both run this, only one sees changes = 1.
    for (let i = 0; i < nights; i++) {
      const { changes } = take.run(req.qty, req.listingId, addDays(req.day, i), req.qty);
      if (changes === 0) throw new BookingError(409, 'Sold out for the selected date(s)');
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO bookings (id, request_id, source, listing_id, day, nights, qty, guest_name,
         id_type, id_last4, total_php, code, created_at)
       VALUES (?, ?, 'WALKIN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, req.requestId, req.listingId, req.day, nights, req.qty, req.guestName, req.idType,
      req.idLast4, listing.price_php * req.qty * nights, newCode(secret), Date.now());
    const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as unknown as BookingRow;
    addOutbox(db, 'WALKIN_BOOKED', id, row);
    return row;
  });
}

export function registerOnline(db: Db, b: Omit<BookingRow, 'source' | 'status' | 'redeemed_at' | 'total_php'>) {
  db.prepare(
    `INSERT OR IGNORE INTO bookings (id, source, listing_id, day, nights, qty, guest_name, id_type,
       id_last4, total_php, code, created_at)
     VALUES (?, 'ONLINE', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(b.id, b.listing_id, b.day, b.nights, b.qty, b.guest_name, b.id_type, b.id_last4, b.code, Date.now());
}

export function cancelOnline(db: Db, bookingId: string): boolean {
  const { changes } = db.prepare(
    `UPDATE bookings SET status = 'CANCELLED' WHERE id = ? AND source = 'ONLINE' AND status = 'CONFIRMED'`,
  ).run(bookingId);
  return changes === 1;
}

// Step 1 at the desk: what does this QR / code say, and is it ours?
export function verify(db: Db, secret: string, listingIds: Set<string>, input: { qr?: string; code?: string }) {
  if (input.qr) {
    const t = verifyTicket(secret, input.qr);
    if (!t) return { result: 'INVALID' as const, reason: 'Signature check failed' };
    if (!listingIds.has(t.listing)) return { result: 'INVALID' as const, reason: 'Ticket is for another island' };
    // Online ticket we have not heard about (e.g. island was offline): the signed
    // QR carries everything we need, so record it and continue.
    registerOnline(db, {
      id: t.id, listing_id: t.listing, day: t.day, nights: t.nights, qty: t.qty,
      guest_name: t.guest, id_type: t.idType, id_last4: t.idLast4, code: t.code,
    });
    return describe(db, t.id);
  }
  if (input.code) {
    const code = input.code.trim().toUpperCase();
    if (!isValidCode(secret, code)) return { result: 'INVALID' as const, reason: 'Not a genuine code' };
    const row = db.prepare('SELECT id FROM bookings WHERE code = ?').get(code) as { id: string } | undefined;
    if (!row) {
      return { result: 'UNKNOWN' as const, reason: 'Genuine code, but not synced to this island yet — scan the QR instead' };
    }
    return describe(db, row.id);
  }
  throw new BookingError(400, 'Provide qr or code');
}

function describe(db: Db, id: string) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as unknown as BookingRow;
  const result = b.status === 'CONFIRMED' ? 'VALID' : b.status;
  return { result, booking: b };
}

// Step 2, after staff checked the physical ID. Succeeds exactly once per booking,
// even if two phones scan the same QR at the same moment.
export function redeem(db: Db, bookingId: string) {
  return transaction(db, () => {
    const { changes } = db.prepare(
      `UPDATE bookings SET status = 'REDEEMED', redeemed_at = ? WHERE id = ? AND status = 'CONFIRMED'`,
    ).run(Date.now(), bookingId);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
    if (!b) throw new BookingError(404, 'Unknown booking');
    if (changes === 0) return { ok: false, result: b.status === 'REDEEMED' ? 'ALREADY_REDEEMED' : b.status, booking: b };
    addOutbox(db, 'REDEEMED', bookingId, { source: b.source, redeemedAt: b.redeemed_at });
    return { ok: true, result: 'CHECKED_IN', booking: b };
  });
}
