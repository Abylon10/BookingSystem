/**
 * app/src/screens/Settings.tsx
 *
 * Settings, opened from the Account tab. Five groups:
 *  1. Profile & account   – who is signed in (Google), or the details saved
 *                           for booking as a guest; sign out; delete account.
 *  2. Security & privacy  – sign-in method, sign out on all devices,
 *                           remember details, clear what this phone keeps.
 *  3. Notifications       – trip reminders and when they ring.
 *  4. App preferences     – day / night / follow the phone, default guests.
 *  5. Connected accounts & payment – Google link, preferred payment method.
 * Toggles and choices apply at once (a short "Saved" note confirms);
 * text fields have their own Save button; destructive actions ask first.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteAccount } from '../api';
import { signIn, signOut, supabase, useGoogleEnabled, type Account } from '../auth';
import { allowReminders, clearReminders, remindersSupported, rescheduleAll } from '../reminders';
import { resetSettings, updateSettings, useSettings, type PayMethod, type Settings as S, type ThemeChoice } from '../settings';
import { colors, radius, shadow, space, themed } from '../theme';
import { askConfirm, Button, ErrorBox, Field, Ionicons, Pills, Stepper, TopBar } from '../ui';

const ID_TYPES = ['PhilSys ID', 'Passport', "Driver's License", 'UMID', 'Student ID'];
const APP_VERSION = '1.0.0';

export function Settings({ account, onBack }: { account: Account | null; onBack: () => void }) {
  const s = useSettings();
  const google = useGoogleEnabled();
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Local copy of the guest details form (saved with its own button).
  const [details, setDetails] = useState(s.details);
  useEffect(() => setDetails(s.details), [s.details]);
  const detailsChanged = JSON.stringify(details) !== JSON.stringify(s.details);

  // Short confirmation after a change.
  function saved(text = 'Saved') {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 1800);
  }
  const change = (patch: Partial<S>, note?: string) => { updateSettings(patch); saved(note); };

  // Trip reminders: asks the phone for permission first.
  async function setReminders(on: boolean) {
    setError(null);
    if (on && !(await allowReminders())) {
      setError('Notifications are blocked for Resortify. Allow them in your phone\'s settings, then try again.');
      return;
    }
    updateSettings({ tripReminders: on });
    await rescheduleAll();
    saved(on ? 'Reminders on' : 'Reminders off');
  }
  async function setReminderTime(t: S['reminderTime']) {
    updateSettings({ reminderTime: t });
    await rescheduleAll();
    saved();
  }

  // Destructive actions, each confirmed first.
  async function doSignOut(everywhere: boolean) {
    const ok = await askConfirm(everywhere ? 'Sign out on all devices?' : 'Sign out?',
      everywhere ? 'You will be signed out on every phone where you use Resortify with this Google account.' : 'Your trips stay saved on this phone.', 'Sign out');
    if (!ok) return;
    await (everywhere ? supabase.auth.signOut({ scope: 'global' }) : signOut());
    saved('Signed out');
  }
  async function clearPhone() {
    const ok = await askConfirm('Clear this phone?', 'Removes the trips list, saved booking details, reminders and settings kept on this phone. Your bookings themselves are not cancelled.', 'Clear');
    if (!ok) return;
    await AsyncStorage.multiRemove(['my-bookings']).catch(() => {});
    await clearReminders();
    await resetSettings();
    saved('Cleared');
  }
  async function removeAccount() {
    if (!account) return;
    const ok = await askConfirm('Delete your account?', 'Your Resortify account and its settings are deleted for good and you are signed out. Bookings stay with the resorts and can still be found with the reference and e-mail.', 'Delete account');
    if (!ok) return;
    setBusy('delete');
    setError(null);
    try {
      await deleteAccount(account.token);
      await signOut();
      saved('Account deleted');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function connectGoogle() {
    setBusy('google');
    setError(null);
    try { await signIn('google'); } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  return (
    <View style={st.screen}>
      <TopBar title="Settings" onBack={onBack} />
      <ScrollView contentContainerStyle={st.body}>
        <ErrorBox message={error} />

        {/* 1. Profile & account */}
        <Group icon="person-circle-outline" title="Profile & account">
          {account ? (
            <>
              <View style={st.who}>
                {account.avatar ? <Image source={{ uri: account.avatar }} style={st.avatar} />
                  : <View style={[st.avatar, st.avatarEmpty]}><Text style={st.initial}>{account.name.slice(0, 1).toUpperCase()}</Text></View>}
                <View style={{ flex: 1 }}>
                  <Text style={st.name}>{account.name}</Text>
                  <Text style={st.sub}>{account.email}</Text>
                </View>
              </View>
              <Text style={st.hint}>Your name, e-mail and photo come from your Google account.</Text>
              <Row icon="log-out-outline" label="Sign out" onPress={() => doSignOut(false)} />
              <Row icon="trash-outline" label={busy === 'delete' ? 'Deleting…' : 'Delete account'} danger onPress={removeAccount} />
            </>
          ) : (
            <>
              <Text style={st.hint}>Booking as a guest. These details fill the booking form so you don't type them every time. They stay on this phone.</Text>
              <Field label="Full name (as on your ID)" value={details.guestName} onChangeText={(v) => setDetails({ ...details, guestName: v })} icon="person-outline" />
              <Field label="E-mail" value={details.email} onChangeText={(v) => setDetails({ ...details, email: v })} keyboardType="email-address" autoCapitalize="none" icon="mail-outline" />
              <Field label="Mobile number" value={details.phone} onChangeText={(v) => setDetails({ ...details, phone: v })} keyboardType="phone-pad" icon="call-outline" />
              <Text style={st.label}>ID you usually bring</Text>
              <Pills options={ID_TYPES} value={details.idType} onChange={(v) => setDetails({ ...details, idType: v })} />
              <Button label={detailsChanged ? 'Save details' : 'Details saved'} icon={detailsChanged ? 'save-outline' : 'checkmark'} variant={detailsChanged ? 'primary' : 'ghost'}
                disabled={!detailsChanged} onPress={() => change({ details: { ...details, guestName: details.guestName.trim(), email: details.email.trim(), phone: details.phone.trim() }, rememberDetails: true })} />
            </>
          )}
        </Group>

        {/* 2. Security & privacy */}
        <Group icon="shield-checkmark-outline" title="Security & privacy">
          <Row icon="key-outline" label="Sign-in method" value={account ? 'Google' : 'Guest (no account)'} />
          {account && <Row icon="phone-portrait-outline" label="Sign out on all devices" onPress={() => doSignOut(true)} />}
          <Toggle icon="document-text-outline" label="Remember my booking details" note="Name, e-mail, phone and ID type. The ID number is never saved." value={s.rememberDetails} onChange={(v) => change({ rememberDetails: v })} />
          <Text style={st.hint}>The resort only receives the ID type and its last 4 digits to check you in. Payments in this version are simulated; no card details are collected.</Text>
          <Row icon="trash-bin-outline" label="Clear data on this phone" danger onPress={clearPhone} />
        </Group>

        {/* 3. Notifications */}
        <Group icon="notifications-outline" title="Notifications">
          {remindersSupported ? (
            <>
              <Toggle icon="alarm-outline" label="Trip reminders" note="A reminder on this phone before each confirmed trip." value={s.tripReminders} onChange={setReminders} />
              {s.tripReminders && (
                <Segment<S['reminderTime']> value={s.reminderTime} onChange={setReminderTime}
                  options={[{ id: 'evening', label: '6 PM the day before', icon: 'moon-outline' }, { id: 'morning', label: '7 AM on the day', icon: 'sunny-outline' }]} />
              )}
            </>
          ) : (
            <Text style={st.hint}>Trip reminders work in the Resortify app on your phone.</Text>
          )}
        </Group>

        {/* 4. App preferences */}
        <Group icon="options-outline" title="App preferences">
          <Text style={st.label}>Theme</Text>
          <Segment<ThemeChoice> value={s.theme} onChange={(t) => change({ theme: t })}
            options={[{ id: 'light', label: 'Day', icon: 'sunny-outline' }, { id: 'dark', label: 'Night', icon: 'moon-outline' }, { id: 'system', label: 'Phone', icon: 'phone-portrait-outline' }]} />
          <View style={st.rowLine}>
            <Ionicons name="people-outline" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={st.rowLabel}>Guests to start with</Text>
              <Text style={st.sub}>Used when you open a resort</Text>
            </View>
            <Stepper value={s.defaultGuests} min={1} max={10} onChange={(n) => change({ defaultGuests: n })} />
          </View>
          <Row icon="language-outline" label="Language" value="English" />
          <Row icon="cash-outline" label="Currency" value="Philippine peso (₱)" />
        </Group>

        {/* 5. Connected accounts & payment */}
        <Group icon="link-outline" title="Connected accounts & payment">
          <View style={st.rowLine}>
            <Ionicons name="logo-google" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={st.rowLabel}>Google</Text>
              <Text style={st.sub}>{account ? `Connected · ${account.email}` : google ? 'Not connected' : 'Coming soon'}</Text>
            </View>
            {!account && google && <Pressable onPress={connectGoogle} style={st.smallBtn}><Text style={st.smallBtnText}>{busy === 'google' ? '…' : 'Connect'}</Text></Pressable>}
          </View>
          <Text style={st.label}>Preferred payment method</Text>
          <Segment<PayMethod> value={s.payMethod} onChange={(m) => change({ payMethod: m })}
            options={[{ id: 'gcash', label: 'GCash', icon: 'phone-portrait-outline' }, { id: 'maya', label: 'Maya', icon: 'wallet-outline' }, { id: 'card', label: 'Card', icon: 'card-outline' }]} />
          <Text style={st.hint}>Picked first on the payment screen. Payments are simulated in this version.</Text>
        </Group>

        <Text style={st.version}>Resortify {APP_VERSION}{account ? ' · settings synced to your account' : ' · settings saved on this phone'}</Text>
      </ScrollView>

      {/* "Saved" note */}
      {toast && <View style={st.toast}><Ionicons name="checkmark-circle" size={18} color="#fff" /><Text style={st.toastText}>{toast}</Text></View>}
    </View>
  );
}

// ---- small building blocks ---------------------------------------------------

// A titled card for one group of settings.
function Group({ icon, title, children }: { icon: keyof typeof Ionicons.glyphMap; title: string; children: ReactNode }) {
  return (
    <View style={st.card}>
      <View style={st.groupHead}><View style={st.groupIcon}><Ionicons name={icon} size={18} color="#fff" /></View><Text style={st.groupTitle}>{title}</Text></View>
      {children}
    </View>
  );
}

// A tappable (or read-only) row.
function Row({ icon, label, value, onPress, danger }: { icon: keyof typeof Ionicons.glyphMap; label: string; value?: string; onPress?: () => void; danger?: boolean }) {
  const color = danger ? colors.danger : colors.primary;
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [st.rowLine, pressed && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[st.rowLabel, { flex: 1 }, danger && { color: colors.danger }]}>{label}</Text>
      {value && <Text style={st.value}>{value}</Text>}
      {onPress && <Ionicons name="chevron-forward" size={18} color={colors.muted} />}
    </Pressable>
  );
}

// An on/off switch row.
function Toggle({ icon, label, note, value, onChange }: { icon: keyof typeof Ionicons.glyphMap; label: string; note?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={st.rowLine}>
      <Ionicons name={icon} size={20} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={st.rowLabel}>{label}</Text>
        {note && <Text style={st.sub}>{note}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.primary, false: colors.line }} thumbColor="#fff" />
    </View>
  );
}

// Segmented choice (two or three options).
function Segment<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; icon: keyof typeof Ionicons.glyphMap }[] }) {
  return (
    <View style={st.seg}>
      {options.map((o) => (
        <Pressable key={o.id} onPress={() => o.id !== value && onChange(o.id)} style={[st.segBtn, value === o.id && st.segOn]}>
          <Ionicons name={o.icon} size={16} color={value === o.id ? '#fff' : colors.ink} />
          <Text style={[st.segText, value === o.id && { color: '#fff' }]} numberOfLines={1}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// Styles for this screen.
const st = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.md, gap: space.md, paddingBottom: 60 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow, shadowOpacity: 0.07 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  groupIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  groupTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  who: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 56, height: 56, borderRadius: 28 },
  avatarEmpty: { backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  initial: { color: '#fff', fontSize: 24, fontWeight: '800' },
  name: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  sub: { color: colors.muted, fontSize: 13, marginTop: 2 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  label: { color: colors.ink, fontWeight: '700', marginBottom: -6 },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  rowLabel: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  value: { color: colors.muted, fontSize: 14 },
  seg: { flexDirection: 'row', backgroundColor: colors.skySoft, borderRadius: radius.pill, padding: 4 },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 4, borderRadius: radius.pill },
  segOn: { backgroundColor: colors.primary },
  segText: { color: colors.ink, fontWeight: '700', fontSize: 13 },
  smallBtn: { backgroundColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 },
  smallBtnText: { color: '#fff', fontWeight: '700' },
  version: { color: colors.muted, fontSize: 12, textAlign: 'center' },
  toast: { position: 'absolute', bottom: 34, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.ok, paddingHorizontal: 18, paddingVertical: 10, borderRadius: radius.pill, ...shadow },
  toastText: { color: '#fff', fontWeight: '700' },
}));
