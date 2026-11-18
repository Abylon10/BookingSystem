/**
 * app/src/reminders.ts
 *
 * Trip reminders: a local notification on the phone before each confirmed
 * trip (6 PM the evening before, or 7 AM on the day — the guest chooses in
 * Settings > Notifications). Nothing is sent from a server; the phone
 * schedules them itself, so they work without an account. Scheduled ids are
 * kept per booking reference so a cancelled trip's reminder can be removed.
 * Not available on the web build (the calls do nothing there).
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import type { Booking } from './api';
import { getSettings, type ReminderTime } from './settings';
import { parseDay } from './ui';

const KEY = 'trip-reminders';   // { [reference]: { id, day, name } }
const CHANNEL = 'trip-reminders';
export const remindersSupported = Platform.OS !== 'web';

type Saved = Record<string, { id: string; day: string; name: string }>;

// Show reminders as a banner even while the app is open.
if (remindersSupported) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
  });
}

async function readSaved(): Promise<Saved> {
  try { return JSON.parse((await AsyncStorage.getItem(KEY)) ?? '{}') as Saved; } catch { return {}; }
}
const writeSaved = (s: Saved) => AsyncStorage.setItem(KEY, JSON.stringify(s)).catch(() => {});

// Asks the phone for permission (Android 13+ / iOS). True when allowed.
export async function allowReminders(): Promise<boolean> {
  if (!remindersSupported) return false;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: 'Trip reminders', importance: Notifications.AndroidImportance.HIGH });
  }
  const now = await Notifications.getPermissionsAsync();
  if (now.granted) return true;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

// When the reminder for a trip starting on `day` should ring.
function ringAt(day: string, when: ReminderTime) {
  const d = parseDay(day);
  if (when === 'evening') { d.setDate(d.getDate() - 1); d.setHours(18, 0, 0, 0); } else d.setHours(7, 0, 0, 0);
  return d;
}

async function scheduleOne(reference: string, day: string, name: string, when: ReminderTime) {
  const date = ringAt(day, when);
  if (date.getTime() <= Date.now() + 60_000) return null; // too late for this trip
  return Notifications.scheduleNotificationAsync({
    content: {
      title: when === 'evening' ? `Tomorrow: ${name}` : `Today: ${name}`,
      body: `Booking ${reference}. Bring the ID you booked with and show this reference at the front desk.`,
      data: { reference },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: CHANNEL },
  });
}

// Schedules the reminder for a confirmed booking (if reminders are on).
export async function remindTrip(b: Pick<Booking, 'reference' | 'day' | 'package_name' | 'status'>) {
  if (!remindersSupported || b.status !== 'CONFIRMED') return;
  const s = getSettings();
  const saved = await readSaved();
  const old = saved[b.reference];
  if (old) await Notifications.cancelScheduledNotificationAsync(old.id).catch(() => {});
  delete saved[b.reference];
  if (s.tripReminders) {
    const id = await scheduleOne(b.reference, b.day, b.package_name, s.reminderTime).catch(() => null);
    if (id) saved[b.reference] = { id, day: b.day, name: b.package_name };
    else saved[b.reference] = { id: '', day: b.day, name: b.package_name }; // keep the trip for later rescheduling
  } else {
    saved[b.reference] = { id: '', day: b.day, name: b.package_name };
  }
  await writeSaved(saved);
}

// Removes a trip's reminder (cancelled booking).
export async function forgetTrip(reference: string) {
  if (!remindersSupported) return;
  const saved = await readSaved();
  if (saved[reference]?.id) await Notifications.cancelScheduledNotificationAsync(saved[reference].id).catch(() => {});
  delete saved[reference];
  await writeSaved(saved);
}

// Re-plans every known trip after the guest changes the reminder settings.
export async function rescheduleAll() {
  if (!remindersSupported) return;
  const s = getSettings();
  const saved = await readSaved();
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
  for (const [ref, t] of Object.entries(saved)) {
    const id = s.tripReminders ? await scheduleOne(ref, t.day, t.name, s.reminderTime).catch(() => null) : null;
    saved[ref] = { ...t, id: id ?? '' };
  }
  await writeSaved(saved);
}

// Forgets all reminders kept on this phone.
export async function clearReminders() {
  if (!remindersSupported) return;
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
  await AsyncStorage.removeItem(KEY).catch(() => {});
}
