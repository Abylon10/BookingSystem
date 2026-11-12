/**
 * app/src/storage.ts
 *
 * Remembers on the phone which bookings this guest made (reference + e-mail),
 * so "My bookings" can refresh them from central without retyping. Only these
 * two fields are kept; the booking itself always comes from the island.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// A saved booking key.
export interface SavedBooking {
  reference: string;
  email: string;
}

const KEY = 'my-bookings';

// Reads the saved list (empty if nothing saved or storage fails).
export async function loadSaved(): Promise<SavedBooking[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedBooking[]) : [];
  } catch {
    return [];
  }
}

// Adds a booking to the front of the list (no duplicates).
export async function saveBooking(b: SavedBooking) {
  const list = (await loadSaved()).filter((x) => x.reference !== b.reference);
  list.unshift({ reference: b.reference.toUpperCase(), email: b.email });
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    // Storage full or unavailable: the booking still exists on the island.
  }
}

// Removes a booking from the list (the booking itself is not touched).
export async function forgetBooking(reference: string) {
  const list = (await loadSaved()).filter((x) => x.reference !== reference);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Ignore: worst case it shows up again next time.
  }
}
