/**
 * app/src/settings.ts
 *
 * The guest's app settings, in one small store:
 *  - kept on the phone (AsyncStorage) so they survive restarts,
 *  - and, when signed in with Google, copied to the account (Supabase user
 *    metadata) so they follow the guest to another phone. The saved booking
 *    details (name, e-mail, phone, ID type) stay on this phone only.
 * Screens read settings with useSettings() and change them with
 * updateSettings(); every change applies at once and is saved.
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authConfigured, supabase } from './auth';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type PayMethod = 'gcash' | 'maya' | 'card';
export type ReminderTime = 'evening' | 'morning';

// Details remembered for the booking form (never the ID digits).
export interface SavedDetails {
  guestName: string;
  email: string;
  phone: string;
  idType: string;
}

export interface Settings {
  theme: ThemeChoice;            // day, night, or follow the phone
  defaultGuests: number;         // guest count the resort page starts with
  payMethod: PayMethod;          // pre-selected on the payment screen
  rememberDetails: boolean;      // fill the booking form from `details`
  details: SavedDetails;
  tripReminders: boolean;        // local reminder before each trip
  reminderTime: ReminderTime;    // 6 PM the evening before, or 7 AM on the day
  updatedAt: number;             // newest copy wins when syncing
}

export const DEFAULTS: Settings = {
  theme: 'light',
  defaultGuests: 2,
  payMethod: 'gcash',
  rememberDetails: true,
  details: { guestName: '', email: '', phone: '', idType: 'PhilSys ID' },
  tripReminders: false,
  reminderTime: 'evening',
  updatedAt: 0,
};

const KEY = 'app-settings';
// Only these are copied to the account; personal details stay on the phone.
const SYNCED: (keyof Settings)[] = ['theme', 'defaultGuests', 'payMethod', 'rememberDetails', 'tripReminders', 'reminderTime', 'updatedAt'];

// ---- the store --------------------------------------------------------------

let current: Settings = { ...DEFAULTS };
let loaded: Promise<Settings> | null = null;
const listeners = new Set<(s: Settings) => void>();
const emit = () => listeners.forEach((l) => l(current));

// Reads the saved settings once (older app versions kept the theme apart).
export function loadSettings(): Promise<Settings> {
  loaded ??= AsyncStorage.multiGet([KEY, 'app-theme'])
    .then(([[, raw], [, oldTheme]]) => {
      const saved = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
      current = { ...DEFAULTS, ...saved, details: { ...DEFAULTS.details, ...saved.details } };
      if (!raw && (oldTheme === 'dark' || oldTheme === 'light')) current.theme = oldTheme;
      emit();
      return current;
    })
    .catch(() => current);
  return loaded;
}

export const getSettings = () => current;

// Changes some settings: applies at once, saves on the phone, and copies the
// shareable part to the signed-in account (failures are ignored: the phone
// copy is enough and the next change retries).
export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch, updatedAt: Date.now() };
  emit();
  AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
  void pushToAccount();
  return current;
}

// Hook: the current settings, re-rendering when they change.
export function useSettings(): Settings {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    loadSettings().then(setS);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

// ---- account sync -----------------------------------------------------------

function shareable(s: Settings) {
  return Object.fromEntries(SYNCED.map((k) => [k, s[k]]));
}

// Copies the shareable settings into the account (Supabase user metadata).
async function pushToAccount() {
  if (!authConfigured) return;
  try {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    await supabase.auth.updateUser({ data: { resortify_settings: shareable(current) } });
  } catch {
    // Offline or signed out: keep the phone copy.
  }
}

// After signing in: the newer of the phone's and the account's settings wins.
export async function syncWithAccount(metadata: Record<string, unknown> | undefined) {
  await loadSettings();
  const remote = metadata?.resortify_settings as Partial<Settings> | undefined;
  if (remote && (remote.updatedAt ?? 0) > current.updatedAt) {
    current = { ...current, ...remote };
    emit();
    AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
  } else if (current.updatedAt > 0) {
    void pushToAccount();
  }
}

// Forgets everything kept on this phone (settings and saved details).
export async function resetSettings() {
  current = { ...DEFAULTS };
  emit();
  await AsyncStorage.removeItem(KEY).catch(() => {});
}
