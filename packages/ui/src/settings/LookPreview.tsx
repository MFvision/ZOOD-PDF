import type { UiLook } from '../state/preferences';

/**
 * A small drawing of each look for the Appearance page: the sidebar, the
 * search bar, three cards and the assistant panel, in that look's own
 * colours. Drawn rather than photographed, so it is sharp at any size, in
 * both languages, and in light and dark.
 */

interface Palette {
  ground: string;
  glow?: string;
  sidebar: string;
  card: string;
  edge: string;
  text: string;
  muted: string;
  accent: string;
  tiles: readonly string[];
  radius: number;
}

const LIGHT: Record<UiLook, Palette> = {
  concept: { ground: '#dfe6f5', glow: '#c9d6f6', sidebar: 'rgb(255 255 255 / 55%)', card: 'rgb(255 255 255 / 85%)', edge: 'rgb(255 255 255 / 90%)', text: '#1d1d2b', muted: '#8a8fa3', accent: '#3b6cf6', tiles: ['#7b61ff', '#ff8a3d', '#3b82f6', '#22b8cf'], radius: 7 },
  glass: { ground: '#eef2f8', glow: '#dbe7fb', sidebar: 'rgb(246 246 248 / 85%)', card: '#ffffff', edge: '#e2e4ea', text: '#1d1d1f', muted: '#8e8e93', accent: '#0a84ff', tiles: ['#0a84ff', '#ff375f', '#30d158', '#bf5af2'], radius: 6 },
  zood: { ground: '#f5f1ed', sidebar: '#e6ddd4', card: '#fbf9f7', edge: '#d6c6b8', text: '#041e42', muted: '#977756', accent: '#73563a', tiles: ['#73563a', '#977756', '#ae8b66', '#73563a'], radius: 6 },
  workbench: { ground: '#f1f1f3', sidebar: '#ffffff', card: '#ffffff', edge: '#dadade', text: '#222226', muted: '#9a9aa2', accent: '#1b63e0', tiles: ['#1b63e0', '#1b63e0', '#1b63e0', '#1b63e0'], radius: 3 },
  mono: { ground: '#f4f4f4', sidebar: '#ffffff', card: '#ffffff', edge: '#d9d9d9', text: '#111111', muted: '#8c8c8c', accent: '#111111', tiles: ['#444444', '#444444', '#444444', '#444444'], radius: 5 },
};

const DARK: Record<UiLook, Palette> = {
  concept: { ground: '#1b1f33', glow: '#2b3566', sidebar: 'rgb(40 44 66 / 70%)', card: 'rgb(52 57 84 / 80%)', edge: 'rgb(255 255 255 / 12%)', text: '#f2f3f8', muted: '#9aa0b8', accent: '#6d8dff', tiles: ['#8f7bff', '#ff9a52', '#5b9bff', '#3cc8de'], radius: 7 },
  glass: { ground: '#1c1c1e', glow: '#26324a', sidebar: 'rgb(44 44 46 / 85%)', card: '#2c2c2e', edge: '#3a3a3c', text: '#f5f5f7', muted: '#8e8e93', accent: '#0a84ff', tiles: ['#0a84ff', '#ff375f', '#30d158', '#bf5af2'], radius: 6 },
  zood: { ground: '#11294b', sidebar: '#041e42', card: '#1d375c', edge: '#2a405e', text: '#f5f1ed', muted: '#ae8b66', accent: '#ae8b66', tiles: ['#ae8b66', '#c9a27c', '#ae8b66', '#977756'], radius: 6 },
  workbench: { ground: '#19191c', sidebar: '#26262a', card: '#2e2e33', edge: '#3c3c43', text: '#ececef', muted: '#6e6e76', accent: '#4b8bf5', tiles: ['#4b8bf5', '#4b8bf5', '#4b8bf5', '#4b8bf5'], radius: 3 },
  mono: { ground: '#141414', sidebar: '#1e1e1e', card: '#262626', edge: '#3a3a3a', text: '#f2f2f2', muted: '#8c8c8c', accent: '#f2f2f2', tiles: ['#cfcfcf', '#cfcfcf', '#cfcfcf', '#cfcfcf'], radius: 5 },
};

export function LookPreview({ look, dark, rtl, plainIcons }: { look: UiLook; dark: boolean; rtl: boolean; plainIcons: boolean }) {
  const p = (dark ? DARK : LIGHT)[look];
  // Drawn left to right, mirrored for Arabic as the app itself is.
  const flip = rtl ? 'translate(160 0) scale(-1 1)' : undefined;
  const workbench = look === 'workbench';
  return (
    <svg className="look-preview" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
      <rect width="160" height="100" fill={p.ground} />
      {p.glow && <ellipse cx="40" cy="12" rx="80" ry="40" fill={p.glow} opacity="0.8" />}
      {p.glow && <ellipse cx="140" cy="100" rx="70" ry="30" fill={p.glow} opacity="0.5" />}
      <g transform={flip}>
        {workbench ? (
          <>
            {/* Tabs on top, the mode bar, the tools list, the page, the rail. */}
            <rect x="0" y="0" width="160" height="9" fill={dark ? '#1b1b1e' : '#e9e9eb'} />
            <rect x="4" y="2" width="30" height="7" rx="1.5" fill={p.card} />
            <rect x="0" y="9" width="160" height="10" fill={p.card} stroke={p.edge} strokeWidth="0.5" />
            {[0, 1, 2, 3].map((i) => (
              <rect key={i} x={6 + i * 16} y="12.5" width="12" height="3" rx="1" fill={i === 1 ? p.accent : p.muted} />
            ))}
            <rect x="0" y="19" width="38" height="81" fill={p.sidebar} stroke={p.edge} strokeWidth="0.5" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <g key={i}>
                <rect x="5" y={25 + i * 11} width="6" height="6" rx="1" fill={plainIcons ? p.muted : p.tiles[i % 4]} opacity={plainIcons ? 1 : 0.9} />
                <rect x="14" y={26.5 + i * 11} width="18" height="3" rx="1" fill={p.muted} />
              </g>
            ))}
            <rect x="60" y="25" width="62" height="70" fill={p.card} stroke={p.edge} strokeWidth="0.5" />
            {[0, 1, 2, 3, 4].map((i) => (
              <rect key={i} x="68" y={33 + i * 8} width={i % 2 ? 36 : 46} height="2.5" rx="1" fill={p.muted} />
            ))}
            <rect x="150" y="19" width="10" height="81" fill={p.card} stroke={p.edge} strokeWidth="0.5" />
            {[0, 1, 2].map((i) => (
              <rect key={i} x="152.5" y={25 + i * 9} width="5" height="5" rx="1" fill={p.muted} />
            ))}
          </>
        ) : (
          <>
            {/* The sidebar, the search bar, the headline, the cards, the assistant. */}
            <rect x="4" y="4" width="34" height="92" rx={p.radius} fill={p.sidebar} stroke={p.edge} strokeWidth="0.5" />
            <rect x="9" y="10" width="7" height="7" rx="2" fill={p.accent} />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <g key={i}>
                <rect x="9" y={24 + i * 10} width="5" height="5" rx="1.2" fill={plainIcons ? p.muted : p.tiles[i % 4]} />
                <rect x="17" y={25.5 + i * 10} width="15" height="2.5" rx="1" fill={p.muted} />
              </g>
            ))}
            <rect x="44" y="6" width="74" height="7" rx="3.5" fill={p.card} stroke={p.edge} strokeWidth="0.5" />
            <rect x="44" y="19" width="48" height="5" rx="1.5" fill={p.text} />
            <rect x="44" y="27" width="36" height="2.5" rx="1" fill={p.muted} />
            {[0, 1, 2].map((i) => (
              <g key={i}>
                <rect x={44 + i * 25} y="35" width="22" height="22" rx={p.radius} fill={p.card} stroke={p.edge} strokeWidth="0.5" />
                <rect x={48 + i * 25} y="39" width="7" height="7" rx="2" fill={plainIcons ? 'none' : p.tiles[i]} stroke={plainIcons ? p.text : 'none'} strokeWidth="0.8" />
                <rect x={48 + i * 25} y="50" width="13" height="2.5" rx="1" fill={p.muted} />
              </g>
            ))}
            {[0, 1, 2].map((i) => (
              <rect key={i} x={44 + i * 25} y="64" width="22" height="30" rx={Math.max(2, p.radius - 2)} fill={p.card} stroke={p.edge} strokeWidth="0.5" />
            ))}
            <rect x="122" y="18" width="34" height="76" rx={p.radius} fill={p.card} stroke={p.edge} strokeWidth="0.5" />
            <rect x="127" y="23" width="6" height="6" rx="1.5" fill={plainIcons ? p.muted : p.tiles[0]} />
            {[0, 1, 2, 3].map((i) => (
              <rect key={i} x="127" y={35 + i * 9} width="24" height="6" rx="3" fill={p.ground} stroke={p.edge} strokeWidth="0.4" />
            ))}
          </>
        )}
      </g>
    </svg>
  );
}
