/**
 * app/src/screens/Welcome.tsx
 *
 * First-launch screen: Biliran photo fading into the ocean, the Resortify
 * logo and name, a big title, and "Get started". Shown once per phone
 * (App.tsx remembers that it was seen).
 */
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { HERO_PHOTOS } from '../scene';
import { colors, radius, space } from '../theme';
import { Ionicons } from '../ui';

export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <View style={st.screen}>
      {/* Photo on the top part of the screen */}
      <Image source={HERO_PHOTOS.welcome} style={st.picture} resizeMode="cover" />
      {/* Smooth fade from the photo into the dark ocean background */}
      <Svg style={st.fade} width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 10 10">
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.ink} stopOpacity="0" />
            <Stop offset="1" stopColor={colors.ink} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="10" height="10" fill="url(#fade)" />
      </Svg>

      {/* App logo and name, top left */}
      <View style={st.brand}>
        <Image source={require('../../assets/resortify-logo.png')} style={st.logo} />
        <Text style={st.brandName}>Resortify</Text>
      </View>

      {/* Title block */}
      <View style={st.content}>
        <Text style={st.kicker}>BILIRAN PROVINCE · PHILIPPINES</Text>
        <Text style={st.title}>Explore{'\n'}Island{'\n'}Escapes</Text>
        <Text style={st.sub}>Resorts, falls, sandbars and island stays across Biliran, Maripipi and Higatangan. Book online, show your reference at the island.</Text>
        <Pressable onPress={onStart} style={({ pressed }) => [st.btn, pressed && { opacity: 0.85 }]}>
          <Text style={st.btnText}>Get started</Text>
          <Ionicons name="arrow-forward" size={18} color={colors.ink} />
        </Pressable>
      </View>
    </View>
  );
}

// Styles for this screen.
const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  picture: { position: 'absolute', top: 0, left: 0, right: 0, height: '64%', width: '100%' },
  fade: { position: 'absolute', left: 0, right: 0, top: '30%', height: '34.5%' },
  brand: { position: 'absolute', top: 52, left: space.lg, flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: radius.pill, paddingLeft: 4, paddingRight: 14, paddingVertical: 4 },
  logo: { width: 36, height: 36, borderRadius: 18 },
  brandName: { color: colors.ink, fontWeight: '800', fontSize: 16, letterSpacing: 0.5 },
  content: { flex: 1, justifyContent: 'flex-end', padding: space.lg, paddingBottom: 48, gap: space.md },
  kicker: { color: colors.sun, fontWeight: '700', letterSpacing: 1.5, fontSize: 12 },
  title: { color: '#fff', fontSize: 52, lineHeight: 56, fontWeight: '800' },
  sub: { color: '#D9F2FA', fontSize: 15, lineHeight: 22 },
  btn: {
    marginTop: space.sm, backgroundColor: colors.sun, borderRadius: radius.pill, paddingVertical: 17,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8,
  },
  btnText: { color: colors.ink, fontSize: 17, fontWeight: '800' },
});
