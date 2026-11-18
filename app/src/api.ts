/**
 * app/src/api.ts
 *
 * Client for central's HTTP API. The app talks ONLY to central (never to
 * the islands directly); central forwards each booking to the island that
 * owns it, so the island's one inventory is shared by online guests and
 * walk-ins. (Supabase is used by the app only to sign in, see auth.ts.)
 *
 * Two kinds of trip can be booked:
 *  - a package, for its own length plus optional extra days (each extra day
 *    adds the package's extra-day fee), or
 *  - build-your-own: an island's services checklist, for a number of days.
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
  extra_day_php: number;            // fee per extra day (× guests for per-guest packages)
  items: PackageItem[];
  day: string;
  end_day: string;
  days: number;
  guests: number;
  available: boolean;               // false when sold out, a service is off, or too many guests
  reason: string | null;            // why it can't be booked, e.g. "Boat transfer unavailable"
  unavailable_services: { id: string; name: string; day: string }[];
  total_php: number;                // price for the chosen guests and extra days
}

// One service of an island's checklist (build-your-own).
export interface Service {
  id: string;
  island_id: string;
  island_name: string;
  name: string;
  kind: string;
  unit: 'person' | 'room' | 'trip';
  price_php: number;                // per unit per day
  available: boolean;
  reason: string | null;
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
  services: Service[];
}

// A day in a package's availability calendar.
export interface CalendarDay {
  day: string;
  status: 'open' | 'low' | 'full' | 'off';
  note: string | null;
}

// Booking statuses: HELD (waiting for payment) → CONFIRMED → CHECKED_IN,
// or RELEASED (payment failed / hold expired) / CANCELLED (refunded).
export type BookingStatus = 'HELD' | 'CONFIRMED' | 'CHECKED_IN' | 'RELEASED' | 'CANCELLED' | 'EXPIRED';

// A booking snapshot, as the island stores it.
export interface Booking {
  reference: string;
  island_id: string;
  island_name: string;
  source: 'ONLINE' | 'WALKIN';
  package_id: string;               // 'custom' for build-your-own
  package_name: string;
  location: string;
  day: string;
  end_day: string;
  nights: number;
  days: number;
  extra_days: number;
  guests: number;
  guest_name: string;
  email: string;
  phone: string;
  id_type: string;
  id_last4: string;
  total_php: number;
  refund_php: number;               // money given back after a cancellation
  refund_preview?: number;          // what cancelling now would give back
  status: BookingStatus;
  hold_expires_at: number | null;
  services?: { name: string; qty: number; days: number }[];
  payment?: { method: string; ref: string };
  stale?: boolean; // true when the island was offline and central answered from its copy
}

// What the guest is about to book (built on the package / build screens).
export interface Trip {
  kind: 'package' | 'custom';
  title: string;
  islandId: string;
  islandName: string;
  imageId: string;                  // package id (or island id) for the picture
  packageId?: string;
  extraDays?: number;
  items?: { serviceId: string; qty: number; name: string }[];
  day: string;
  endDay: string;
  days: number;
  guests: number;
  total: number;
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

// The island part of a trip request, as central expects it.
const tripBody = (t: Trip) => (t.kind === 'package'
  ? { packageId: t.packageId, extraDays: t.extraDays ?? 0 }
  : { islandId: t.islandId, items: (t.items ?? []).map((i) => ({ serviceId: i.serviceId, qty: i.qty })), days: t.days });

// ===========================================================================
// Endpoints
// ===========================================================================

// Searches all islands in parallel through central. `days` = how many days
// the services checklist is checked for (build-your-own).
export function searchPackages(day: string, guests = 1, extraDays = 0, days = 1) {
  return request<SearchResult>(`/api/packages?day=${day}&guests=${guests}&extraDays=${extraDays}&days=${days}`);
}

// Availability calendar of a package (open / low / full / off per day).
export function packageCalendar(packageId: string, from: string, count: number, guests: number) {
  return request<{ days: CalendarDay[] }>(`/api/packages/${encodeURIComponent(packageId)}/calendar?from=${from}&count=${count}&guests=${guests}`);
}

// Price and end date of a trip before booking.
export function quote(t: Pick<Trip, 'kind' | 'islandId' | 'packageId' | 'extraDays' | 'items' | 'days' | 'day' | 'guests'>) {
  return request<{ total_php: number; days: number; end_day: string; name: string; unavailable_services: { name: string; day: string }[] }>(
    '/api/quote', { method: 'POST', body: JSON.stringify({ ...tripBody(t as Trip), day: t.day, guests: t.guests }) });
}

// Step 1 of the saga: hold the units on the island for a few minutes.
export function holdBooking(requestId: string, trip: Trip, g: GuestDetails) {
  return request<Booking>('/api/bookings', {
    method: 'POST',
    headers: { 'Idempotency-Key': requestId },
    body: JSON.stringify({ ...tripBody(trip), day: trip.day, guests: trip.guests, ...g }),
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

// Cancels a booking (units go back on sale); the answer has refund_php.
export function cancelBooking(reference: string, email: string) {
  return request<Booking>(`/api/bookings/${encodeURIComponent(reference)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

// The signed-in guest's bookings (all islands), via their account token.
export function myBookings(token: string) {
  return request<{ email: string; bookings: Booking[] }>('/api/me/bookings', { headers: { Authorization: `Bearer ${token}` } });
}
