/**
 * app/src/screens/PackageDetail.tsx
 *
 * Package detail + booking form. Shows what the package includes, then asks
 * for the guest's details. "Reserve" sends a HOLD to central, which forwards
 * it to the island: the units are set aside for a few minutes while the guest
 * pays. Sold out (409) and island offline (503) are shown as plain messages.
 */
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { ApiError, holdBooking, newRequestId, type Booking, type GuestDetails, type Package } from '../api';
import { colors, peso, space } from '../theme';
import { Button, Card, ErrorBox, Field, Header, InfoRow, Pills, prettyDay } from '../ui';

// ID types the front desk accepts (matches the island console).
const ID_TYPES = ['PhilSys ID', 'Passport', "Driver's License", 'UMID', 'Student ID'];

export function PackageDetail({ pkg, onBack, onHeld }: { pkg: Package; onBack: () => void; onHeld: (b: Booking) => void }) {
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

  const blocked = !pkg.available || pkg.guests > pkg.max_guests;

  return (
    <KeyboardAvoidingView style={st.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Header title={pkg.name} subtitle={`${pkg.island_name} · ${pkg.location}`} onBack={onBack} />
      <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
        {/* About the package and what it includes */}
        <Card>
          <Text style={st.desc}>{pkg.description}</Text>
          <Text style={st.section}>Includes</Text>
          {pkg.items.map((i) => (
            <Text key={i.service_id} style={st.item}>• {i.name} × {i.qty}{i.per_guest ? ' per guest' : ''}</Text>
          ))}
        </Card>

        {/* Summary of the trip being booked */}
        <Card>
          <InfoRow label="Date" value={prettyDay(pkg.day)} />
          <InfoRow label="Length" value={pkg.nights ? `${pkg.nights} night${pkg.nights > 1 ? 's' : ''}` : 'Day trip'} />
          <InfoRow label="Guests" value={String(pkg.guests)} />
          <InfoRow label="Price" value={pkg.pricing === 'per_guest' ? `${peso(pkg.price_php)} per guest` : `${peso(pkg.price_php)} per package`} />
          <InfoRow label="Total" value={peso(pkg.total_php)} strong />
        </Card>

        {blocked ? (
          <ErrorBox message={pkg.guests > pkg.max_guests ? `This package allows at most ${pkg.max_guests} guests.` : 'Not available on this date. Try another date.'} />
        ) : (
          <>
            {/* Guest details; the ID is checked at the front desk on arrival */}
            <Text style={st.section}>Guest details</Text>
            <Field label="Full name (as on ID)" value={form.guestName} onChangeText={set('guestName')} error={errors.guestName} autoCapitalize="words" />
            <Field label="E-mail" value={form.email} onChangeText={set('email')} error={errors.email} keyboardType="email-address" autoCapitalize="none" />
            <Field label="Mobile (optional)" value={form.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
            <Text style={st.label}>ID you will show at the front desk</Text>
            <Pills options={ID_TYPES} value={form.idType} onChange={set('idType')} />
            <Field label="Last 4 of the ID number" value={form.idLast4} onChangeText={set('idLast4')} error={errors.idLast4} maxLength={4} keyboardType="number-pad" />

            <ErrorBox message={error} />
            <Button label={`Reserve · ${peso(pkg.total_php)}`} onPress={reserve} busy={busy} variant="accent" />
            <Text style={st.hint}>We hold your spot for 10 minutes while you pay.</Text>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sand },
  body: { padding: space.md, gap: space.md, paddingBottom: 60 },
  desc: { color: colors.ink, lineHeight: 21 },
  section: { color: colors.ink, fontWeight: '700', fontSize: 15, marginTop: space.xs },
  item: { color: colors.muted },
  label: { color: colors.ink, fontWeight: '600', fontSize: 13 },
  hint: { color: colors.muted, textAlign: 'center', fontSize: 12 },
});
