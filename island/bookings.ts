/**
 * island/bookings.ts
 *
 * Business logic of an island node, independent of HTTP or gRPC:
 *  - bookWalkin    : sell from the walk-in pool at the front desk
 *  - registerOnline: remember an online booking so the desk can check it in
 *  - cancelOnline  : mark an online booking cancelled (central's saga step)
 *  - verify        : step 1 of check-in, "what is this ticket?"
 *  - redeem        : step 2 of check-in, "ID matches, check them in" (once only)
 */
import { randomUUID } from 'node:crypto';
import { addDays } from '../shared/config.ts';
import { isValidCode, newCode, signTicket, verifyTicket, type TicketPayload } from '../shared/ticket.ts';
import { addOutbox, getBooking, transaction, type BookingRow, type Db } from './db.ts';

// An error that carries the HTTP status to send back (400 bad input, 404 not
// found, 409 sold out). Any other error becomes a 500.
export class BookingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// What the staff console sends for a walk-in booking.
export interface WalkinRequest {
  requestId: string;   // idempotency key: resending the same request books once
  listingId: string;
  day: string;         // YYYY-MM-DD, first night / tour date
  nights?: number;     // resorts only, default 1
  qty: number;         // rooms or seats
  guestName: string;
  idType: string;
  idLast4: string;
}

// The details an online booking carries when it is registered on the island.
export type OnlineBookingInfo = Pick<BookingRow,
  'id' | 'listing_id' | 'day' | 'nights' | 'qty' | 'guest_name' | 'id_type' | 'id_last4' | 'code'>;

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

// Builds the guest's ticket (manual code + signed QR) from a booking row.
export function ticketFor(secret: string, b: BookingRow): { code: string; qr: string } {
  const payload: TicketPayload = {
    v: 1, id: b.id, code: b.code, listing: b.listing_id, day: b.day, nights: b.nights,
    qty: b.qty, guest: b.guest_name, idType: b.id_type, idLast4: b.id_last4,
  };
  return { code: b.code, qr: signTicket(secret, payload) };
}

// ---------------------------------------------------------------------------
// Walk-in booking
// ---------------------------------------------------------------------------

// Sells units from this island's walk-in pool and returns the new booking.
// Safe under concurrency: many desks/phones can call this at the same time for
// the last room and exactly the right number succeed.
export function bookWalkin(db: Db, secret: string, req: WalkinRequest): BookingRow {
  // 1. Validate input before touching the database.
  const nights = req.nights ?? 1;
  if (!/^\d{4}$/.test(req.idLast4)) throw new BookingError(400, 'idLast4 must be 4 digits');
  if (req.qty < 1 || nights < 1) throw new BookingError(400, 'qty and nights must be >= 1');

  // 2. Idempotency: if this request id was already booked (the console retried
  //    after a timeout, or the button was double-clicked), return that booking
  //    instead of selling a second time.
  const existing = db.prepare('SELECT * FROM bookings WHERE request_id = ?').get(req.requestId) as
    BookingRow | undefined;
  if (existing) return existing;

  // 3. The listing must belong to this island; its price is needed for the total.
  const listing = db.prepare('SELECT price_php FROM listings WHERE id = ?').get(req.listingId) as
    { price_php: number } | undefined;
  if (!listing) throw new BookingError(404, 'Unknown listing for this island');

  // 4. Take the units and create the booking in ONE transaction.
  //    The race fix is the "AND available >= ?" condition: the check and the
  //    decrement happen in a single atomic UPDATE, so when two requests race for
  //    the last room only one sees changes = 1. A multi-night stay updates one
  //    row per night; if any night is full we throw, the transaction rolls back
  //    and the nights already taken are given back automatically.
  const take = db.prepare(
    'UPDATE inventory SET available = available - ? WHERE listing_id = ? AND day = ? AND available >= ?',
  );
  return transaction(db, () => {
    for (let i = 0; i < nights; i++) {
      const { changes } = take.run(req.qty, req.listingId, addDays(req.day, i), req.qty);
      if (changes === 0) throw new BookingError(409, 'Sold out for the selected date(s)');
    }

    // Units are reserved: write the booking with a fresh ticket code.
    const id = randomUUID();
    db.prepare(
      `INSERT INTO bookings (id, request_id, source, listing_id, day, nights, qty, guest_name,
         id_type, id_last4, total_php, code, created_at)
       VALUES (?, ?, 'WALKIN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, req.requestId, req.listingId, req.day, nights, req.qty, req.guestName, req.idType,
      req.idLast4, listing.price_php * req.qty * nights, newCode(secret), Date.now());

    // Queue the event for central in the same transaction (outbox pattern).
    const row = getBooking(db, id)!;
    addOutbox(db, 'WALKIN_BOOKED', id, row);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Online bookings (owned by central, mirrored here for check-in)
// ---------------------------------------------------------------------------

// Records an online booking so staff can find it by code. INSERT OR IGNORE
// makes it idempotent: central's RegisterOnlineBooking and a QR scan may both
// register the same booking and only the first insert counts. total_php is 0
// because payment was taken by central, not at this desk.
export function registerOnline(db: Db, b: OnlineBookingInfo): void {
  db.prepare(
    `INSERT OR IGNORE INTO bookings (id, source, listing_id, day, nights, qty, guest_name, id_type,
       id_last4, total_php, code, created_at)
     VALUES (?, 'ONLINE', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(b.id, b.listing_id, b.day, b.nights, b.qty, b.guest_name, b.id_type, b.id_last4, b.code, Date.now());
}

// Marks an online booking cancelled so it can no longer be checked in.
// Only CONFIRMED online bookings can be cancelled; returns false otherwise
// (already used, already cancelled, or unknown here).
export function cancelOnline(db: Db, bookingId: string): boolean {
  const { changes } = db.prepare(
    `UPDATE bookings SET status = 'CANCELLED' WHERE id = ? AND source = 'ONLINE' AND status = 'CONFIRMED'`,
  ).run(bookingId);
  return changes === 1;
}

// ---------------------------------------------------------------------------
// Check-in, step 1: verify
// ---------------------------------------------------------------------------

// Result of verify(), shown to staff before they check the physical ID.
//   VALID      ready to check in
//   REDEEMED / CANCELLED / NO_SHOW   cannot be checked in
//   INVALID    forged, damaged, or for another island
//   UNKNOWN    genuine code but this island has no details yet
export type VerifyResult =
  | { result: 'INVALID' | 'UNKNOWN'; reason: string }
  | { result: 'VALID' | 'REDEEMED' | 'CANCELLED' | 'NO_SHOW'; booking: BookingRow };

// Identifies a ticket from either a scanned QR or a typed code. Does NOT change
// the booking; staff must confirm the guest's ID first and then call redeem().
export function verify(db: Db, secret: string, listingIds: Set<string>,
  input: { qr?: string; code?: string }): VerifyResult {
  // QR path: the signed payload contains everything, so it works offline.
  if (input.qr) {
    const t = verifyTicket(secret, input.qr);
    if (!t) return { result: 'INVALID', reason: 'Signature check failed' };
    if (!listingIds.has(t.listing)) return { result: 'INVALID', reason: 'Ticket is for another island' };

    // An online ticket this island has not heard about yet (it was offline when
    // central tried to register it): the signed payload is trustworthy, so
    // record it now. For tickets already known this does nothing.
    registerOnline(db, {
      id: t.id, listing_id: t.listing, day: t.day, nights: t.nights, qty: t.qty,
      guest_name: t.guest, id_type: t.idType, id_last4: t.idLast4, code: t.code,
    });
    return describe(db, t.id);
  }

  // Manual code path: the check value proves the code is genuine, but the
  // details must come from the local database.
  if (input.code) {
    const code = input.code.trim().toUpperCase();
    if (!isValidCode(secret, code)) return { result: 'INVALID', reason: 'Not a genuine code' };
    const row = db.prepare('SELECT id FROM bookings WHERE code = ?').get(code) as { id: string } | undefined;
    if (!row) {
      return { result: 'UNKNOWN', reason: 'Genuine code, but not synced to this island yet — scan the QR instead' };
    }
    return describe(db, row.id);
  }

  throw new BookingError(400, 'Provide qr or code');
}

// Turns a booking's status into a verify result: CONFIRMED means VALID,
// anything else is reported as-is so staff see why it cannot be used.
function describe(db: Db, id: string): VerifyResult {
  const booking = getBooking(db, id)!;
  const result = booking.status === 'CONFIRMED' ? 'VALID' : booking.status;
  return { result, booking };
}

// ---------------------------------------------------------------------------
// Check-in, step 2: redeem
// ---------------------------------------------------------------------------

// Checks the guest in after staff matched their physical ID.
// The UPDATE only matches a CONFIRMED booking, so it succeeds exactly once:
// if two phones scan the same QR at the same moment, one gets CHECKED_IN and
// the other ALREADY_REDEEMED.
export function redeem(db: Db, bookingId: string) {
  return transaction(db, () => {
    // Atomic state change CONFIRMED -> REDEEMED.
    const { changes } = db.prepare(
      `UPDATE bookings SET status = 'REDEEMED', redeemed_at = ? WHERE id = ? AND status = 'CONFIRMED'`,
    ).run(Date.now(), bookingId);

    // Explain the outcome to the caller.
    const booking = getBooking(db, bookingId);
    if (!booking) throw new BookingError(404, 'Unknown booking');
    if (changes === 0) {
      const result = booking.status === 'REDEEMED' ? 'ALREADY_REDEEMED' : booking.status;
      return { ok: false, result, booking };
    }

    // Tell central (via the outbox) so the guest's app shows "checked in".
    addOutbox(db, 'REDEEMED', bookingId, { source: booking.source, redeemedAt: booking.redeemed_at });
    return { ok: true, result: 'CHECKED_IN', booking };
  });
}
