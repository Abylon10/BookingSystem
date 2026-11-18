/**
 * app/src/storage.ts
 *
 * Remembers on the phone which bookings this guest made, so "My bookings"
 * can refresh them from central without retyping (reference + e-mail), and
 * so the app can notice a repeat booking of the same resort (which island,
 * when it was paid). The booking itself always comes from the island.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// A saved booking key, plus what the repeat-booking notice needs.
export interface SavedBooking {
  reference: string;
  email: string;
  islandId?: string;     // the resort's island
  resort?: string;       // package name shown in the notice
  day?: string;          // arrival day
  paidAt?: number;       // when payment confirmed it (ms)
}

const KEY = 'my-bookings';
const REPEAT_OFF_KEY = 'repeat-notice-off'; // local date the notice was turned off for

// Reads the saved list (empty if nothing saved or storage fails).
export async function loadSaved(): Promise<SavedBooking[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedBooking[]) : [];
  } catch {
    return [];
  }
}

async function write(list: SavedBooking[]) {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    // Storage full or unavailable: the booking still exists on the island.
  }
}

// Adds or updates a booking at the front of the list (no duplicates; fields
// already known are kept).
export async function saveBooking(b: SavedBooking) {
  const list = await loadSaved();
  const ref = b.reference.toUpperCase();
  const old = list.find((x) => x.reference === ref);
  const merged: SavedBooking = { ...old, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)), reference: ref } as SavedBooking;
  await write([merged, ...list.filter((x) => x.reference !== ref)]);
}

// Records that a booking was paid (counts for the repeat-booking notice).
export async function markPaid(reference: string) {
  const list = await loadSaved();
  const b = list.find((x) => x.reference === reference.toUpperCase());
  if (!b) return;
  b.paidAt = Date.now();
  await write(list);
}

// Removes a booking from the list (the booking itself is not touched).
export async function forgetBooking(reference: string) {
  const list = (await loadSaved()).filter((x) => x.reference !== reference);
  await write(list);
}

// ---------------------------------------------------------------------------
// Repeat-booking notice
// ---------------------------------------------------------------------------

// The phone's local date as YYYY-MM-DD.
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The guest's latest paid booking of this resort (island) made within the
// last 12 hours or earlier today, or null.
export async function recentBookingOf(islandId: string, now = Date.now()): Promise<SavedBooking | null> {
  const list = await loadSaved();
  const hit = list
    .filter((b) => b.islandId === islandId && b.paidAt)
    .sort((a, b) => b.paidAt! - a.paidAt!)
    .find((b) => now - b.paidAt! < 12 * 3600_000 || localDay(b.paidAt!) === localDay(now));
  return hit ?? null;
}

// "Don't show this again today": remembered until the phone's date changes.
export async function repeatNoticeOff(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(REPEAT_OFF_KEY)) === localDay(Date.now()); } catch { return false; }
}
export async function turnOffRepeatNoticeToday() {
  try { await AsyncStorage.setItem(REPEAT_OFF_KEY, localDay(Date.now())); } catch { /* ignore */ }
}
