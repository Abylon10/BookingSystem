/**
 * app/src/api.ts
 *
 * Client for central's HTTP API (v2: packages, hold → pay → confirm).
 * The app talks ONLY to central, never to Supabase or the islands directly.
 * Central forwards each booking to the island that owns the package, so the
 * island's one inventory is shared by online guests and walk-ins.
 */

// Central's address. Set EXPO_PUBLIC_CENTRAL_URL in app/.env, e.g. the Render
// URL (https://biliran-central.onrender.com) or a LAN laptop (http://IP:4000).
export const CENTRAL_URL = (process.env.EXPO_PUBLIC_CENTRAL_URL ?? 'https://biliran-central.onrender.com').replace(/\/+$/, '');

// ===========================================================================
// Types (match the JSON central returns)
// ===========================================================================

// One service inside a package, e.g. "Pumpboat seat × 1 per guest".
export interface PackageItem {
  service_id: string;
  name: string;
  kind: string;
  qty: number;
  per_guest: boolean;
}

// A package as returned by GET /api/packages for a date and guest count.
export interface Package {
  id: string;
  island_id: string;
  island_name: string;
  name: string;
  location: string;
  description: string;
  price_php: number;
  pricing: 'per_guest' | 'per_package';
  nights: number;
  max_guests: number;
  items: PackageItem[];
  day: string;
  guests: number;
  spots: number;       // how many more bookings of this size still fit that day
  available: boolean;  // false when sold out, marked unavailable, or too many guests
  total_php: number;   // price for the chosen guest count
}

// Per-island status in a search: offline islands' packages are not sold online.
export interface IslandStatus {
  id: string;
  name?: string;
  status: 'online' | 'offline';
  ms: number;
  via?: string;
}

// The search response.
export interface SearchResult {
  day: string;
  guests: number;
  fanoutMs: number;
  islands: IslandStatus[];
  packages: Package[];
}

// Booking statuses: HELD (waiting for payment) → CONFIRMED → CHECKED_IN,
// or RELEASED (payment failed / hold expired) / CANCELLED.
export type BookingStatus = 'HELD' | 'CONFIRMED' | 'CHECKED_IN' | 'RELEASED' | 'CANCELLED' | 'EXPIRED';

// A booking snapshot, as the island stores it.
export interface Booking {
  reference: string;
  island_id: string;
  island_name: string;
  source: 'ONLINE' | 'WALKIN';
  package_id: string;
  package_name: string;
  location: string;
  day: string;
  nights: number;
  guests: number;
  guest_name: string;
  email: string;
  phone: string;
  id_type: string;
  id_last4: string;
  total_php: number;
  status: BookingStatus;
  hold_expires_at: number | null;
  payment?: { method: string; ref: string };
  stale?: boolean; // true when the island was offline and central answered from its copy
}

// What the guest types into the booking form.
export interface GuestDetails {
  guestName: string;
  email: string;
  phone: string;
  idType: string;
  idLast4: string;
}

// ===========================================================================
// Helpers
// ===========================================================================

// An error carrying the HTTP status, so screens can tell "sold out" (409)
// from "island offline" (503) or "payment declined" (402).
export class ApiError extends Error {
  status: number;
  body?: any;
  constructor(status: number, message: string, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Sends one request to central and parses the JSON. Non-2xx → ApiError with
// central's own error text. Network failures become status 0.
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CENTRAL_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, `Can't reach central (${CENTRAL_URL}). Check your internet.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body);
  return body as T;
}

// A random id for the Idempotency-Key header. If the phone retries the same
// booking (bad signal), central and the island return the SAME booking
// instead of creating a second one.
export function newRequestId() {
  return 'app-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ===========================================================================
// Endpoints
// ===========================================================================

// Searches all islands in parallel through central.
export function searchPackages(day: string, guests: number) {
  return request<SearchResult>(`/api/packages?day=${day}&guests=${guests}`);
}

// Step 1 of the saga: hold the units on the island for a few minutes.
export function holdBooking(requestId: string, packageId: string, day: string, guests: number, g: GuestDetails) {
  return request<Booking>('/api/bookings', {
    method: 'POST',
    headers: { 'Idempotency-Key': requestId },
    body: JSON.stringify({ packageId, day, guests, ...g }),
  });
}

// Step 2: pay (simulated). Success → CONFIRMED; failure → hold released (402).
export function payBooking(reference: string, method: string, simulateFail = false) {
  return request<Booking>(`/api/bookings/${reference}/pay`, {
    method: 'POST',
    body: JSON.stringify({ method, ...(simulateFail ? { simulate: 'fail' } : {}) }),
  });
}

// Looks up a booking; the e-mail must match, so references can't be guessed.
export function getBooking(reference: string, email: string) {
  return request<Booking>(`/api/bookings/${encodeURIComponent(reference)}?email=${encodeURIComponent(email)}`);
}

// Cancels a booking (units go back to the island's inventory).
export function cancelBooking(reference: string, email: string) {
  return request<Booking>(`/api/bookings/${encodeURIComponent(reference)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}
