/**
 * app/src/ui.tsx
 *
 * Shared building blocks for every screen: date helpers, top bar, buttons,
 * form fields, chips, guest stepper, status badge, info rows, and the
 * calendar date picker. Keeping them here keeps the screens short and the
 * look consistent with the palette in theme.ts.
 */
import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { BookingStatus } from './api';
import { colors, radius, shadow, space } from './theme';

// Re-exported so screens import icons from one place.
export { Ionicons };

// ===========================================================================
// Dates
// ===========================================================================

// Local date as YYYY-MM-DD (the format central and the islands use).
export function isoDay(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// "2026-11-20" -> a local Date at midnight.
export function parseDay(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Adds n days to a YYYY-MM-DD string.
export function addDays(day: string, n: number) {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

// "2026-11-20" -> "Fri, Nov 20".
export function prettyDay(day: string) {
  return parseDay(day).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
}

// "Fri, Nov 20" or "Fri, Nov 20 – Sat, Nov 21" for overnight packages.
export function tripDates(day: string, nights: number) {
  return nights ? `${prettyDay(day)} – ${prettyDay(addDays(day, nights))}` : prettyDay(day);
}

// ===========================================================================
// Top bar (round back button + title), used on inner screens
// ===========================================================================

export function TopBar({ title, onBack, right }: { title?: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <View style={s.topbar}>
      {onBack ? <RoundButton icon="chevron-back" onPress={onBack} /> : <View style={{ width: 42 }} />}
      <Text style={s.topTitle} numberOfLines={1}>{title}</Text>
      {right ?? <View style={{ width: 42 }} />}
    </View>
  );
}

// White circular icon button (back, bookmark, close).
export function RoundButton({ icon, onPress, dark }: { icon: keyof typeof Ionicons.glyphMap; onPress: () => void; dark?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [s.round, dark && { backgroundColor: colors.primary }, pressed && { opacity: 0.7 }]}>
      <Ionicons name={icon} size={20} color={dark ? '#fff' : colors.ink} />
    </Pressable>
  );
}

// ===========================================================================
// Buttons and fields
// ===========================================================================

// Pill-shaped main button. `accent` = yellow "Book now" style (ink text).
export function Button({ label, onPress, busy, disabled, variant = 'primary', icon }: {
  label: string; onPress: () => void; busy?: boolean; disabled?: boolean;
  variant?: 'primary' | 'accent' | 'ghost' | 'danger' | 'light'; icon?: keyof typeof Ionicons.glyphMap;
}) {
  const off = disabled || busy;
  const bg = { primary: colors.primary, accent: colors.accent, ghost: 'transparent', danger: 'transparent', light: '#fff' }[variant];
  const fg = { primary: '#fff', accent: colors.ink, ghost: colors.primary, danger: colors.danger, light: colors.ink }[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        s.btn, { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && { borderWidth: 1.5, borderColor: colors.primary },
        variant === 'danger' && { borderWidth: 1.5, borderColor: '#EBC3B9' },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : (
        <View style={s.btnRow}>
          {icon && <Ionicons name={icon} size={18} color={fg} />}
          <Text style={[s.btnText, { color: fg }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

// A labelled, rounded text input with an optional error line.
export function Field({ label, error, icon, ...props }: TextInputProps & { label: string; error?: string; icon?: keyof typeof Ionicons.glyphMap }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <View style={[s.inputWrap, error ? { borderColor: colors.danger } : null]}>
        {icon && <Ionicons name={icon} size={18} color={colors.muted} />}
        <TextInput placeholderTextColor="#8DA3AE" style={s.input} {...props} />
      </View>
      {error ? <Text style={s.fieldError}>{error}</Text> : null}
    </View>
  );
}

// A row of selectable chips (island filter, ID type, payment method).
export function Pills<T extends string>({ options, value, onChange, labelOf, dotOf }: {
  options: T[]; value: T; onChange: (v: T) => void; labelOf?: (v: T) => string; dotOf?: (v: T) => string | null;
}) {
  return (
    <View style={s.pills}>
      {options.map((o) => {
        const on = o === value;
        const dot = dotOf?.(o);
        return (
          <Pressable key={o} onPress={() => onChange(o)} style={[s.pill, on && s.pillOn]}>
            {dot ? <View style={[s.dot, { backgroundColor: dot }]} /> : null}
            <Text style={[s.pillText, on && s.pillTextOn]}>{labelOf ? labelOf(o) : o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// "−  2  +" guest stepper in an outlined pill (reference design).
export function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <View style={s.stepper}>
      <Pressable onPress={() => onChange(Math.max(min, value - 1))} hitSlop={8} disabled={value <= min}>
        <Ionicons name="remove" size={22} color={value <= min ? colors.line : colors.primary} />
      </Pressable>
      <Text style={s.stepValue}>{value}</Text>
      <Pressable onPress={() => onChange(Math.min(max, value + 1))} hitSlop={8} disabled={value >= max}>
        <Ionicons name="add" size={22} color={value >= max ? colors.line : colors.primary} />
      </Pressable>
    </View>
  );
}

// ===========================================================================
// Status badge, info rows, cards, messages
// ===========================================================================

// Coloured badge for a booking status (`center` when it sits under centred text).
export function StatusBadge({ status, center }: { status: BookingStatus; center?: boolean }) {
  const look: Record<string, [string, string, string]> = {
    HELD: ['Waiting for payment', colors.accent2, colors.ink],
    CONFIRMED: ['Confirmed', colors.primary, '#fff'],
    CHECKED_IN: ['Checked in', colors.ok, '#fff'],
    RELEASED: ['Released', colors.line, colors.muted],
    EXPIRED: ['Expired', colors.line, colors.muted],
    CANCELLED: ['Cancelled', '#F6DDD6', colors.danger],
  };
  const [text, bg, fg] = look[status] ?? [status, colors.line, colors.muted];
  return <Text style={[s.badge, { backgroundColor: bg, color: fg }, center && { alignSelf: 'center' }]}>{text}</Text>;
}

// "Label ........ value" row.
export function InfoRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={[s.infoValue, strong && s.infoStrong]}>{value}</Text>
    </View>
  );
}

// White rounded card with a soft shadow.
export function Card({ children }: { children: ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

// Section title with an optional right-hand note ("Show all").
export function SectionTitle({ title, note }: { title: string; note?: string }) {
  return (
    <View style={s.sectionRow}>
      <Text style={s.section}>{title}</Text>
      {note ? <Text style={s.sectionNote}>{note}</Text> : null}
    </View>
  );
}

// Message box for errors (red) or notices (yellow).
export function ErrorBox({ message, tone = 'error' }: { message: string | null; tone?: 'error' | 'notice' }) {
  if (!message) return null;
  return (
    <View style={[s.msg, tone === 'notice' && s.notice]}>
      <Ionicons name={tone === 'notice' ? 'information-circle' : 'alert-circle'} size={18} color={tone === 'notice' ? colors.ink : colors.danger} />
      <Text style={[s.msgText, tone === 'notice' && { color: colors.ink }]}>{message}</Text>
    </View>
  );
}

// ===========================================================================
// Calendar date picker (month grid, Mon-first). Overnight packages show the
// stay as a highlighted range, like the reference design.
// ===========================================================================

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Calendar({ value, onChange, min, max, nights = 0 }: {
  value: string; onChange: (day: string) => void; min: string; max: string; nights?: number;
}) {
  // Month being shown (first day of that month).
  const [month, setMonth] = useState(() => { const d = parseDay(value); return new Date(d.getFullYear(), d.getMonth(), 1); });

  // Grid cells: blanks before the 1st (Mon-first), then each day.
  const lead = (month.getDay() + 6) % 7;
  const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysIn }, (_, i) => isoDay(new Date(month.getFullYear(), month.getMonth(), i + 1))),
  ];
  const end = addDays(value, nights);
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const canPrev = isoDay(month) > min.slice(0, 8) + '01';
  const canNext = isoDay(new Date(month.getFullYear(), month.getMonth() + 1, 1)) <= max;

  return (
    <View>
      {/* Month name with arrows */}
      <View style={s.calHead}>
        <Pressable onPress={() => shift(-1)} disabled={!canPrev} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={canPrev ? colors.ink : colors.line} />
        </Pressable>
        <Text style={s.calMonth}>{month.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</Text>
        <Pressable onPress={() => shift(1)} disabled={!canNext} hitSlop={10}>
          <Ionicons name="chevron-forward" size={22} color={canNext ? colors.ink : colors.line} />
        </Pressable>
      </View>
      {/* Weekday names */}
      <View style={s.calRow}>{WEEK.map((w) => <Text key={w} style={s.calWeek}>{w}</Text>)}</View>
      {/* Day cells: selected start/end in blue, nights in between in light sky */}
      <View style={s.calGrid}>
        {cells.map((d, i) => {
          if (!d) return <View key={`b${i}`} style={s.calCell} />;
          const off = d < min || d > max;
          const edge = d === value || (nights > 0 && d === end);
          const inside = nights > 0 && d > value && d < end;
          return (
            <Pressable key={d} disabled={off} onPress={() => onChange(d)} style={[s.calCell, inside && s.calRange]}>
              <View style={[s.calDay, edge && s.calDayOn]}>
                <Text style={[s.calText, off && { color: colors.line }, edge && { color: '#fff', fontWeight: '700' }]}>{parseDay(d).getDate()}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Bottom sheet holding the calendar; closes after a date is picked.
export function DateSheet({ open, onClose, ...cal }: Parameters<typeof Calendar>[0] & { open: boolean; onClose: () => void }) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.sheetBackdrop} onPress={onClose} />
      <View style={s.sheet}>
        <View style={s.sheetHandle} />
        <View style={s.sheetHead}>
          <Text style={s.section}>Choose your date</Text>
          <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color={colors.muted} /></Pressable>
        </View>
        <Calendar {...cal} onChange={(d) => { cal.onChange(d); onClose(); }} />
      </View>
    </Modal>
  );
}

// ===========================================================================
// Styles
// ===========================================================================
const s = StyleSheet.create({
  // Top bar
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 52, paddingHorizontal: space.md, paddingBottom: space.sm, gap: space.sm },
  topTitle: { flex: 1, textAlign: 'center', color: colors.ink, fontSize: 17, fontWeight: '700' },
  round: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...shadow, shadowOpacity: 0.1 },

  // Buttons
  btn: { borderRadius: radius.pill, paddingVertical: 15, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center', minHeight: 54 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnText: { fontSize: 16, fontWeight: '700' },

  // Fields
  label: { color: colors.ink, fontWeight: '600', fontSize: 13 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14 },
  input: { flex: 1, paddingVertical: 13, fontSize: 16, color: colors.ink },
  fieldError: { color: colors.danger, fontSize: 12 },

  // Chips
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line },
  pillOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  pillText: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  pillTextOn: { color: '#fff' },
  dot: { width: 7, height: 7, borderRadius: 4 },

  // Stepper
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 18, borderWidth: 1.5, borderColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: 16, height: 54, backgroundColor: '#fff' },
  stepValue: { color: colors.ink, fontSize: 20, fontWeight: '700', minWidth: 18, textAlign: 'center' },

  // Badge, rows, card, section, messages
  badge: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill, overflow: 'hidden', fontSize: 12, fontWeight: '700' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, gap: space.md },
  infoLabel: { color: colors.muted },
  infoValue: { color: colors.ink, flexShrink: 1, textAlign: 'right', fontWeight: '500' },
  infoStrong: { fontWeight: '800', fontSize: 17 },
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, gap: space.sm, ...shadow, shadowOpacity: 0.06 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  section: { color: colors.ink, fontWeight: '800', fontSize: 18 },
  sectionNote: { color: colors.muted, fontSize: 13 },
  msg: { flexDirection: 'row', gap: 8, backgroundColor: '#FBE7E1', padding: space.md, borderRadius: radius.sm, alignItems: 'flex-start' },
  notice: { backgroundColor: '#FFF3D1' },
  msgText: { color: colors.danger, flex: 1, lineHeight: 20 },

  // Calendar
  calHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.md, paddingHorizontal: space.sm },
  calMonth: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  calRow: { flexDirection: 'row' },
  calWeek: { flex: 1, textAlign: 'center', color: colors.muted, fontWeight: '600', fontSize: 13, marginBottom: 6 },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: { width: `${100 / 7}%`, height: 44, alignItems: 'center', justifyContent: 'center' },
  calRange: { backgroundColor: colors.skySoft },
  calDay: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  calDayOn: { backgroundColor: colors.primary },
  calText: { color: colors.ink, fontSize: 15 },

  // Bottom sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(1, 60, 88, 0.35)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.md, paddingBottom: 40 },
  sheetHandle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: space.md },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.md },
});
