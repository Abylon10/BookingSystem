/**
 * app/src/screens/GuestForm.tsx
 *
 * Step 2 of booking: who is coming. Shows a summary of the trip, asks for the
 * guest's details, then "Reserve" sends a HOLD to central, which forwards it
 * to the island: the units are set aside for 10 minutes while the guest pays.
 * Sold out (409) and island offline (503) are shown as plain messages.
 */
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, holdBooking, newRequestId, type Booking, type GuestDetails, type Package } from '../api';
import { PackageImage } from '../scene';
import { colors, peso, radius, shadow, space } from '../theme';
import { Button, ErrorBox, Field, Pills, TopBar, tripDates } from '../ui';

// ID types the front desk accepts (matches the island console).
const ID_TYPES = ['PhilSys ID', 'Passport', "Driver's License", 'UMID', 'Student ID'];

export function GuestForm({ pkg, onBack, onHeld }: { pkg: Package; onBack: () => void; onHeld: (b: Booking) => void }) {
  // Form values and per-field validation errors.
  const [form, setForm] = useState<GuestDetails>({ guestName: '', email: '', phone: '', idType: ID_TYPES[0], idLast4: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof GuestDetails, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One request id per booking attempt, reused if the guest taps "Reserve"
  // again after a network error, so a retry never books twice.
  const requestId = useRef(newRequestId());

  // Updates one form field and clears its error.
  const set = (k: keyof GuestDetails) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  // Checks the form on the phone first (the island checks again).
  function validate() {
    const e: typeof errors = {};
    if (form.guestName.trim().length < 2) e.guestName = 'Enter the name on the ID';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) e.email = 'Enter a valid e-mail';
    if (!/^\d{4}$/.test(form.idLast4.trim())) e.idLast4 = 'Last 4 digits of the ID number';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // Sends the hold. On success → payment screen.
  async function reserve() {
    if (!validate()) return;
    setBusy(true);
    setError(null);
    try {
      const booking = await holdBooking(requestId.current, pkg.id, pkg.day, pkg.guests, {
        ...form, guestName: form.guestName.trim(), email: form.email.trim(), idLast4: form.idLast4.trim(),
      });
      onHeld(booking);
    } catch (err) {
      const e = err as ApiError;
      // Friendly text for the expected failures; central's text otherwise.
      if (e.status === 409) setError(`Sorry, it just sold out: ${e.message}`);
      else if (e.status === 503) setError(`${pkg.island_name} is offline right now, so it can't take online bookings. Please try again later.`);
      else setError(e.message);
      // A definite "no" (4xx) means a new attempt should get a new id.
      if (e.status >= 400 && e.status < 500) requestId.current = newRequestId();
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={st.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <TopBar title="Guest details" onBack={onBack} />
      <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
        {/* Trip summary card */}
        <View style={st.summary}>
          <PackageImage packageId={pkg.id} style={st.thumb} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={st.name}>{pkg.name}</Text>
            <Text style={st.meta}>{pkg.island_name}</Text>
            <Text style={st.meta}>{tripDates(pkg.day, pkg.nights)} · {pkg.guests} guest{pkg.guests > 1 ? 's' : ''}</Text>
            <Text style={st.total}>{peso(pkg.total_php)}</Text>
          </View>
        </View>

        {/* Guest details; the ID is checked at the front desk on arrival */}
        <Field label="Full name (as on ID)" icon="person-outline" value={form.guestName} onChangeText={set('guestName')} error={errors.guestName} autoCapitalize="words" />
        <Field label="E-mail" icon="mail-outline" value={form.email} onChangeText={set('email')} error={errors.email} keyboardType="email-address" autoCapitalize="none" />
        <Field label="Mobile (optional)" icon="call-outline" value={form.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
        <Text style={st.label}>ID you will show at the front desk</Text>
        <Pills options={ID_TYPES} value={form.idType} onChange={set('idType')} />
        <Field label="Last 4 digits of the ID number" icon="card-outline" value={form.idLast4} onChangeText={set('idLast4')} error={errors.idLast4} maxLength={4} keyboardType="number-pad" />

        <ErrorBox message={error} />
        <Button label={`Reserve · ${peso(pkg.total_php)}`} onPress={reserve} busy={busy} variant="accent" icon="lock-closed-outline" />
        <Text style={st.hint}>We hold your spot for 10 minutes while you pay.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.md, gap: space.md, paddingBottom: 60 },
  summary: { flexDirection: 'row', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, padding: 10, alignItems: 'center', ...shadow, shadowOpacity: 0.06 },
  thumb: { width: 84, height: 84, borderRadius: 14 },
  name: { color: colors.ink, fontWeight: '800', fontSize: 16 },
  meta: { color: colors.muted, fontSize: 13 },
  total: { color: colors.primary, fontWeight: '800', fontSize: 16, marginTop: 2 },
  label: { color: colors.ink, fontWeight: '600', fontSize: 13 },
  hint: { color: colors.muted, textAlign: 'center', fontSize: 12 },
});
