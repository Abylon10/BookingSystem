import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

// Crockford-style alphabet: no 0/O, 1/I/L, so codes survive being read aloud or typed.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export interface TicketPayload {
  v: 1;
  id: string;        // booking id
  code: string;      // BK-XXXX-YYYY
  listing: string;
  day: string;
  nights: number;
  qty: number;
  guest: string;
  idType: string;
  idLast4: string;
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function encode(bytes: Buffer, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// XXXX is random; YYYY is a check value derived from XXXX, so any island can
// tell a genuine code from a typo or a made-up one without asking central.
export function newCode(secret: string): string {
  let part = '';
  for (let i = 0; i < 4; i++) part += ALPHABET[randomInt(ALPHABET.length)];
  return `BK-${part}-${encode(hmac(secret, part), 4)}`;
}

export function isValidCode(secret: string, code: string): boolean {
  const m = /^BK-([2-9A-Z]{4})-([2-9A-Z]{4})$/.exec(code.trim().toUpperCase());
  return m !== null && encode(hmac(secret, m[1]), 4) === m[2];
}

// QR content: base64url(json) + "." + base64url(hmac). Verifiable offline.
export function signTicket(secret: string, payload: TicketPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body).toString('base64url')}`;
}

export function verifyTicket(secret: string, qr: string): TicketPayload | null {
  const [body, sig] = qr.trim().split('.');
  if (!body || !sig) return null;
  const expected = hmac(secret, body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketPayload;
  } catch {
    return null;
  }
}
