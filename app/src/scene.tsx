/**
 * app/src/scene.tsx
 *
 * Package pictures. A real photo is used when one is registered in
 * PHOTOS below; otherwise a drawn SVG scene in the app palette is shown
 * (falls, island, sandbar or sunset), so the app looks finished without
 * any image files and works offline.
 *
 * To add a photo: put e.g. assets/packages/biliran-falls-day.jpg in the app
 * and add `'biliran-falls-day': require('../assets/packages/biliran-falls-day.jpg')`
 * to PHOTOS.
 */
import { Image, type ImageSourcePropType, type StyleProp, type ViewStyle, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

// Package id -> photo. Empty until the team adds real Biliran photos.
const PHOTOS: Record<string, ImageSourcePropType> = {};

// The four drawn scenes.
export type SceneKind = 'falls' | 'island' | 'sandbar' | 'sunset';

// Picks a scene from the package id (keywords in the seed ids).
export function sceneFor(packageId: string): SceneKind {
  if (packageId.includes('falls')) return 'falls';
  if (packageId.includes('sandbar')) return 'sandbar';
  if (/overnight|2d1n|escape|lagundi/.test(packageId)) return 'sunset';
  return 'island';
}

// Shows the package photo, or its drawn scene, filling `style`.
export function PackageImage({ packageId, style }: { packageId: string; style?: StyleProp<ViewStyle> }) {
  const photo = PHOTOS[packageId];
  return (
    <View style={[{ overflow: 'hidden', backgroundColor: '#A8E8F9' }, style]}>
      {photo
        ? <Image source={photo} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        : <Scene kind={sceneFor(packageId)} />}
    </View>
  );
}

// A palm tree at (x, y) with the given height (trunk + five leaves).
function Palm({ x, y, h, color = '#0E5C47' }: { x: number; y: number; h: number; color?: string }) {
  const top = y - h;
  return (
    <>
      <Path d={`M${x} ${y} Q${x + h * 0.12} ${y - h * 0.5} ${x + h * 0.05} ${top}`} stroke="#6B4B2A" strokeWidth={h * 0.07} fill="none" strokeLinecap="round" />
      {[[-1, -0.1], [1, -0.1], [-0.8, 0.25], [0.8, 0.25], [0, -0.3]].map(([dx, dy], i) => (
        <Path
          key={i}
          d={`M${x + h * 0.05} ${top} Q${x + h * 0.05 + dx * h * 0.35} ${top + dy * h * 0.3 - h * 0.12} ${x + h * 0.05 + dx * h * 0.55} ${top + h * 0.18 + dy * h * 0.2}`}
          stroke={color} strokeWidth={h * 0.09} fill="none" strokeLinecap="round"
        />
      ))}
    </>
  );
}

// The drawn scene itself, scaled to cover its box (like a cover photo).
export function Scene({ kind }: { kind: SceneKind }) {
  const sunset = kind === 'sunset';
  return (
    <Svg width="100%" height="100%" viewBox="0 0 400 260" preserveAspectRatio="xMidYMid slice">
      <Defs>
        {/* Sky: daylight blue, or warm yellow-orange for the overnight packages */}
        <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={sunset ? '#F5A201' : '#7FD3EE'} />
          <Stop offset="1" stopColor={sunset ? '#FFD35B' : '#D9F5FD'} />
        </LinearGradient>
        {/* Sea: deep ocean blues */}
        <LinearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={sunset ? '#00537A' : '#1C8FB5'} />
          <Stop offset="1" stopColor="#013C58" />
        </LinearGradient>
      </Defs>

      <Rect x="0" y="0" width="400" height="260" fill="url(#sky)" />
      {/* Sun and clouds */}
      <Circle cx={sunset ? 200 : 320} cy={sunset ? 150 : 55} r={sunset ? 46 : 26} fill={sunset ? '#FFD35B' : '#FFF4C2'} opacity={sunset ? 0.95 : 1} />
      {!sunset && (
        <>
          <Ellipse cx="90" cy="50" rx="46" ry="12" fill="#fff" opacity="0.9" />
          <Ellipse cx="120" cy="42" rx="30" ry="12" fill="#fff" opacity="0.9" />
          <Ellipse cx="250" cy="80" rx="34" ry="8" fill="#fff" opacity="0.7" />
        </>
      )}

      {/* Waterfall: green cliffs with falling water and mist (Biliran falls) */}
      {kind === 'falls' && (
        <>
          <Path d="M0 60 L120 40 L150 260 L0 260 Z" fill="#1F7A5C" />
          <Path d="M400 50 L250 45 L215 260 L400 260 Z" fill="#17694F" />
          <Path d="M0 110 Q60 90 130 120 L140 260 L0 260 Z" fill="#2E9370" />
          <Rect x="150" y="48" width="78" height="170" fill="#E9FAFF" />
          {[160, 178, 196, 214].map((x) => <Rect key={x} x={x} y="55" width="4" height="150" fill="#A8E8F9" opacity="0.8" />)}
          <Rect x="0" y="205" width="400" height="55" fill="url(#sea)" />
          <Ellipse cx="190" cy="210" rx="80" ry="16" fill="#fff" opacity="0.75" />
          <Palm x={60} y={140} h={60} />
          <Palm x={335} y={130} h={55} />
        </>
      )}

      {/* Islands and sandbars sit on open sea */}
      {kind !== 'falls' && <Rect x="0" y="150" width="400" height="110" fill="url(#sea)" />}

      {/* Island with palms (Sambawan / Maripipi) */}
      {kind === 'island' && (
        <>
          <Path d="M80 155 Q170 80 290 150 Z" fill="#1F7A5C" />
          <Path d="M240 152 Q300 112 360 154 Z" fill="#2E9370" />
          <Path d="M70 156 Q180 140 300 156 Z" fill="#FFE3A1" />
          <Palm x={150} y={130} h={52} />
          <Palm x={195} y={118} h={62} />
          <Palm x={235} y={128} h={48} />
        </>
      )}

      {/* Sandbar with a pumpboat (Higatangan) */}
      {kind === 'sandbar' && (
        <>
          <Path d="M20 182 Q200 160 380 186 Q200 196 20 182 Z" fill="#FFE3A1" />
          <Path d="M300 150 Q340 125 380 150 Z" fill="#1F7A5C" />
          <Palm x={340} y={145} h={34} />
          {/* Pumpboat: hull, outriggers */}
          <Path d="M110 215 L190 215 L180 226 L120 226 Z" fill="#fff" />
          <Path d="M100 230 L200 230" stroke="#FFBA42" strokeWidth="3" />
          <Rect x="146" y="200" width="6" height="15" fill="#F5A201" />
        </>
      )}

      {/* Sunset: island silhouette for the overnight stays */}
      {kind === 'sunset' && (
        <>
          <Path d="M0 152 Q90 110 170 150 Z" fill="#0B4A63" />
          <Palm x={70} y={135} h={58} color="#0B4A63" />
          <Palm x={110} y={140} h={46} color="#0B4A63" />
          {[170, 185, 200].map((y, i) => <Rect key={y} x={175 - i * 12} y={y} width={50 + i * 24} height="3" rx="1.5" fill="#FFD35B" opacity={0.7 - i * 0.2} />)}
        </>
      )}

      {/* Gentle wave lines on the water */}
      {[200, 225, 245].map((y, i) => (
        <Path key={y} d={`M${20 + i * 40} ${y} q15 -6 30 0 t30 0`} stroke="#A8E8F9" strokeWidth="2" fill="none" opacity="0.6" />
      ))}
    </Svg>
  );
}
