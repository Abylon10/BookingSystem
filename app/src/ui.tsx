/**
 * app/src/ui.tsx
 *
 * Small shared building blocks used by every screen: header, buttons, form
 * fields, status badge, and date helpers. Keeping them here makes the screens
 * short and the look consistent with the palette in theme.ts.
 */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import type { BookingStatus } from './api';
import { colors, radius, space } from './theme';

// ===========================================================================
// Dates
// ===========================================================================

// Local date as YYYY-MM-DD (the format central and the islands use).
export function isoDay(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// The next `n` days starting today, for the date chips.
export function nextDays(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    return d;
  });
}

// "2026-11-20" → "Fri, Nov 20".
export function prettyDay(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ===========================================================================
// Header
// ===========================================================================

// Teal header with a title, optional subtitle, optional back button, and any
// extra content underneath (e.g. island status chips).
export function Header({ title, subtitle, onBack, children }: { title: string; subtitle?: string; onBack?: () => void; children?: ReactNode }) {
  return (
    <View style={s.header}>
      {onBack && (
        <Pressable onPress={onBack} hitSlop={12} style={s.back}>
          <Text style={s.backText}>‹ Back</Text>
        </Pressable>
      )}
      <Text style={s.title}>{title}</Text>
      {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

// ===========================================================================
// Buttons and fields
// ===========================================================================

// Main action button. `variant` picks the colour; shows a spinner while busy.
export function Button({ label, onPress, busy, disabled, variant = 'primary' }: {
  label: string; onPress: () => void; busy?: boolean; disabled?: boolean; variant?: 'primary' | 'accent' | 'ghost' | 'danger';
}) {
  const off = disabled || busy;
  const bg = { primary: colors.primary, accent: colors.accent, ghost: 'transparent', danger: colors.danger }[variant];
  const fg = variant === 'accent' ? colors.ink : variant === 'ghost' ? colors.primary : '#fff';
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.8 : 1 }, variant === 'ghost' && s.btnGhost]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

// A labelled text input with an optional error line under it.
export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor="#9AA6AD" style={[s.input, error ? s.inputError : null]} {...props} />
      {error ? <Text style={s.fieldError}>{error}</Text> : null}
    </View>
  );
}

// A row of selectable pills (date chips, ID type, payment method).
export function Pills<T extends string>({ options, value, onChange, labelOf }: {
  options: T[]; value: T; onChange: (v: T) => void; labelOf?: (v: T) => string;
}) {
  return (
    <View style={s.pills}>
      {options.map((o) => (
        <Pressable key={o} onPress={() => onChange(o)} style={[s.pill, o === value && s.pillOn]}>
          <Text style={[s.pillText, o === value && s.pillTextOn]}>{labelOf ? labelOf(o) : o}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// − 2 + stepper for the guest count.
export function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <View style={s.stepper}>
      <Pressable onPress={() => onChange(Math.max(min, value - 1))} style={s.stepBtn} hitSlop={8}>
        <Text style={s.stepText}>−</Text>
      </Pressable>
      <Text style={s.stepValue}>{value}</Text>
      <Pressable onPress={() => onChange(Math.min(max, value + 1))} style={s.stepBtn} hitSlop={8}>
        <Text style={s.stepText}>+</Text>
      </Pressable>
    </View>
  );
}

// ===========================================================================
// Status badge and info rows
// ===========================================================================

// Coloured badge for a booking status.
export function StatusBadge({ status }: { status: BookingStatus }) {
  const look: Record<string, [string, string]> = {
    HELD: ['Waiting for payment', colors.accent],
    CONFIRMED: ['Confirmed', colors.primary],
    CHECKED_IN: ['Checked in', colors.ok],
    RELEASED: ['Released', colors.muted],
    EXPIRED: ['Expired', colors.muted],
    CANCELLED: ['Cancelled', colors.danger],
  };
  const [text, bg] = look[status] ?? [status, colors.muted];
  return <Text style={[s.badge, { backgroundColor: bg, color: bg === colors.accent ? colors.ink : '#fff' }]}>{text}</Text>;
}

// "Label ........ value" row used on the confirmation and booking cards.
export function InfoRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={[s.infoValue, strong && s.infoStrong]}>{value}</Text>
    </View>
  );
}

// White rounded card.
export function Card({ children }: { children: ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

// Red message box for errors returned by central.
export function ErrorBox({ message }: { message: string | null }) {
  return message ? <Text style={s.errorBox}>{message}</Text> : null;
}

// ===========================================================================
// Styles
// ===========================================================================
const s = StyleSheet.create({
  // Header
  header: {
    backgroundColor: colors.primary, paddingTop: 52, paddingHorizontal: space.md, paddingBottom: space.md,
    borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg,
  },
  back: { marginBottom: space.sm },
  backText: { color: '#D6E6EA', fontSize: 16 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#D6E6EA', marginTop: 2 },

  // Buttons
  btn: { borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 50 },
  btnGhost: { borderWidth: 1.5, borderColor: colors.primary },
  btnText: { fontSize: 16, fontWeight: '700' },

  // Fields
  label: { color: colors.ink, fontWeight: '600', fontSize: 13 },
  input: {
    backgroundColor: '#fff', borderRadius: radius.sm, borderWidth: 1, borderColor: '#D9D3C6',
    paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, color: colors.ink,
  },
  inputError: { borderColor: colors.danger },
  fieldError: { color: colors.danger, fontSize: 12 },

  // Pills
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  pill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: '#fff', borderWidth: 1, borderColor: '#D9D3C6' },
  pillOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { color: colors.ink, fontSize: 13 },
  pillTextOn: { color: '#fff', fontWeight: '700' },

  // Stepper
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stepBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.secondary, alignItems: 'center', justifyContent: 'center' },
  stepText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  stepValue: { color: colors.ink, fontSize: 18, fontWeight: '700', minWidth: 20, textAlign: 'center' },

  // Badge, info rows, card, error
  badge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden', fontSize: 12, fontWeight: '700' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, gap: space.md },
  infoLabel: { color: colors.muted },
  infoValue: { color: colors.ink, flexShrink: 1, textAlign: 'right' },
  infoStrong: { fontWeight: '700', fontSize: 16 },
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, gap: space.sm },
  errorBox: { backgroundColor: '#F6E1DC', color: colors.danger, padding: space.md, borderRadius: radius.sm },
});
