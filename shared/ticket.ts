/**
 * shared/ticket.ts
 *
 * Ticket codes and QR payloads.
 *
 * Every booking gets two things the guest can show at the front desk:
 *  1. a short manual code, e.g. "BK-7F3K-Q9WM", that staff can type in, and
 *  2. a QR payload that carries the full booking details plus a signature.
 *
 * Both are protected with HMAC-SHA256 using the shared TICKET_SECRET. That lets
 * an island verify a ticket WITHOUT asking central, which is what makes offline
 * check-in possible.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

// Characters used in codes. Leaves out 0/O, 1/I/L so a code read aloud or
// copied from a screen is hard to mistype.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// Everything an island needs to check a guest in without contacting central.
// Field names are kept short because they end up inside the QR image.
export interface TicketPayload {
  v: 1;              // payload format version, for future changes
  id: string;        // booking id (uuid)
  code: string;      // manual code, BK-XXXX-YYYY
  listing: string;   // listing id, also tells which island owns the ticket
  day: string;       // check-in / tour date, YYYY-MM-DD
  nights: number;    // nights for resorts, 1 for tours
  qty: number;       // rooms or seats
  guest: string;     // guest name, shown to staff for the ID check
  idType: string;    // e.g. "PhilSys ID", "Passport"
  idLast4: string;   // last 4 digits of the ID; the full number is never stored
}

// Raw HMAC-SHA256 of `data` with `secret`.
function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

// Turns the first `length` bytes into code characters. Used to make the short,
// human-friendly check value from an HMAC.
function encode(bytes: Buffer, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Creates a new manual code "BK-XXXX-YYYY":
//   XXXX = 4 random characters (identifies the booking)
//   YYYY = 4 characters derived from HMAC(XXXX)
// Anyone with the secret can recompute YYYY from XXXX, so a typo or an invented
// code is rejected immediately, even offline. Uniqueness of the whole code is
// enforced by the databases' UNIQUE constraints.
export function newCode(secret: string): string {
  let part = '';
  for (let i = 0; i < 4; i++) part += ALPHABET[randomInt(ALPHABET.length)];
  return `BK-${part}-${encode(hmac(secret, part), 4)}`;
}

// Checks that a typed code has the right shape and that its check value matches.
// Accepts lower case and surrounding spaces because staff type these by hand.
export function isValidCode(secret: string, code: string): boolean {
  const m = /^BK-([2-9A-Z]{4})-([2-9A-Z]{4})$/.exec(code.trim().toUpperCase());
  return m !== null && encode(hmac(secret, m[1]), 4) === m[2];
}

// Builds the QR content: base64url(JSON payload) + "." + base64url(signature).
// Similar to a JWT but simpler. Anyone can read the payload; only someone with
// the secret can produce a valid signature, so the details cannot be edited.
export function signTicket(secret: string, payload: TicketPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body).toString('base64url')}`;
}

// Verifies a QR string and returns its payload, or null if it was tampered
// with, signed with another secret, or is not a ticket at all.
export function verifyTicket(secret: string, qr: string): TicketPayload | null {
  // Split "body.signature"; anything without both parts is not a ticket.
  const [body, sig] = qr.trim().split('.');
  if (!body || !sig) return null;

  // Compare signatures in constant time so the comparison itself does not leak
  // how many leading bytes matched (a classic timing attack).
  const expected = hmac(secret, body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  // Signature is good: decode the payload. A parse error still means "invalid".
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketPayload;
  } catch {
    return null;
  }
}
