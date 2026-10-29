/**
 * The premium colour themes: each palette Mohammed chose, mapped to a day and a night side.
 * styles/looks/premium.css carries the same colours as CSS tokens (premiumThemes.test.ts keeps
 * the two in step), and LookPreview draws its little pictures from here.
 *
 * Roles: bg is the window (the 60), side the sidebar, card the cards, raised a selected row,
 * line the borders, text and muted the two text colours, accent and onAccent the main button,
 * ink links and icons, hi and onHi the highlighter, glow the soft light at the top of home,
 * c30 the palette's 30 colour (tints the sidebar and borders).
 */
export interface ThemeSide {
  bg: string;
  side: string;
  card: string;
  raised: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  ink: string;
  hi: string;
  onHi: string;
  glow: string;
  c30: string;
}

export interface PremiumTheme {
  id: PremiumLook;
  /** The three colours of the palette, as shown on its card. */
  swatch: readonly [string, string, string];
  light: ThemeSide;
  dark: ThemeSide;
}

export type PremiumLook = 'lantern' | 'garden' | 'silver' | 'amethyst' | 'walnut' | 'latte' | 'terra' | 'atlas';

export const PREMIUM_THEMES: readonly PremiumTheme[] = [
  {
    id: 'lantern',
    swatch: ['#5b4632', '#f4d9a0', '#c8792c'],
    light: { bg: '#faf3e4', side: '#f4e3be', card: '#fffaf0', raised: '#f4d9a0', line: '#e6d3ae', text: '#3a2c1f', muted: '#76614a', accent: '#c8792c', onAccent: '#2b2119', ink: '#9a561a', hi: '#f4d9a0', onHi: '#3a2c1f', glow: '#f4d9a0', c30: '#5b4632' },
    dark: { bg: '#2b2119', side: '#231a13', card: '#3a2d21', raised: '#5b4632', line: '#4e3d2c', text: '#f7ebd3', muted: '#cdb896', accent: '#c8792c', onAccent: '#1e150d', ink: '#f4d9a0', hi: '#f4d9a0', onHi: '#2b2119', glow: '#c8792c', c30: '#f4d9a0' },
  },
  {
    id: 'garden',
    swatch: ['#171717', '#06110c', '#a31c1b'],
    light: { bg: '#f1f4ef', side: '#e3eae3', card: '#fafcf9', raised: '#dce8df', line: '#cbd8ce', text: '#06110c', muted: '#4c6356', accent: '#a31c1b', onAccent: '#fff6f4', ink: '#a31c1b', hi: '#cfe6d8', onHi: '#06110c', glow: '#9fd3b8', c30: '#06110c' },
    dark: { bg: '#06110c', side: '#171717', card: '#10211a', raised: '#173026', line: '#1f3a2e', text: '#ecf3ee', muted: '#9fc7b1', accent: '#c0262a', onAccent: '#fff4f2', ink: '#ee6a5e', hi: '#9fd3b8', onHi: '#06110c', glow: '#a31c1b', c30: '#171717' },
  },
  {
    id: 'silver',
    swatch: ['#2a2a2a', '#c0c0c0', '#e10600'],
    light: { bg: '#e9e9e9', side: '#dcdcdc', card: '#f6f6f6', raised: '#c0c0c0', line: '#cfcfcf', text: '#2a2a2a', muted: '#5e5e5e', accent: '#e10600', onAccent: '#fff', ink: '#bf0500', hi: '#2a2a2a', onHi: '#f6f6f6', glow: '#c0c0c0', c30: '#2a2a2a' },
    dark: { bg: '#1c1c1c', side: '#171717', card: '#2a2a2a', raised: '#363636', line: '#3a3a3a', text: '#ededed', muted: '#c0c0c0', accent: '#e10600', onAccent: '#fff', ink: '#ff5c50', hi: '#c0c0c0', onHi: '#1c1c1c', glow: '#e10600', c30: '#c0c0c0' },
  },
  {
    id: 'amethyst',
    swatch: ['#050505', '#3b0a6b', '#00e5ff'],
    light: { bg: '#f5f2fa', side: '#eae3f4', card: '#fcfbfe', raised: '#e2d6f2', line: '#dcd1ec', text: '#1a0833', muted: '#5b4a78', accent: '#3b0a6b', onAccent: '#fff', ink: '#00707f', hi: '#b8f6ff', onHi: '#1a0833', glow: '#00e5ff', c30: '#3b0a6b' },
    dark: { bg: '#09070d', side: '#0e0a16', card: '#171024', raised: '#3b0a6b', line: '#2a1a42', text: '#f2edf9', muted: '#b7a6d3', accent: '#00e5ff', onAccent: '#050505', ink: '#5ceeff', hi: '#3b0a6b', onHi: '#f2edf9', glow: '#3b0a6b', c30: '#3b0a6b' },
  },
  {
    id: 'walnut',
    swatch: ['#87a96b', '#5a3e2b', '#d5851f'],
    light: { bg: '#f3f1ea', side: '#e2e9d8', card: '#fbfaf6', raised: '#d5e2c8', line: '#d9d6c8', text: '#3b2a1d', muted: '#6a5a4c', accent: '#d5851f', onAccent: '#2b1e14', ink: '#99580b', hi: '#f6d9a8', onHi: '#3b2a1d', glow: '#87a96b', c30: '#87a96b' },
    dark: { bg: '#1e1712', side: '#19130f', card: '#2b211a', raised: '#3a2c21', line: '#43342a', text: '#f3ecdf', muted: '#b9c9a8', accent: '#d5851f', onAccent: '#1e1712', ink: '#e9a24a', hi: '#87a96b', onHi: '#1e1712', glow: '#87a96b', c30: '#87a96b' },
  },
  {
    id: 'latte',
    swatch: ['#b7a89a', '#e8dcc6', '#722f37'],
    light: { bg: '#f3ecdf', side: '#e8dcc6', card: '#fbf7f0', raised: '#e1d3bb', line: '#d6c8b5', text: '#2e1a1d', muted: '#6b5a52', accent: '#722f37', onAccent: '#fbf4ea', ink: '#722f37', hi: '#e8dcc6', onHi: '#2e1a1d', glow: '#b7a89a', c30: '#b7a89a' },
    dark: { bg: '#211819', side: '#1b1314', card: '#2e2325', raised: '#4a2a2f', line: '#3d3032', text: '#f2e9da', muted: '#c4b6a8', accent: '#a2464f', onAccent: '#fbf2e6', ink: '#e28b95', hi: '#e8dcc6', onHi: '#211819', glow: '#722f37', c30: '#e8dcc6' },
  },
  {
    id: 'terra',
    swatch: ['#9caf88', '#a7a7a7', '#cc5500'],
    light: { bg: '#f0f0ec', side: '#e1e7d9', card: '#f9f9f6', raised: '#d3ddc7', line: '#d3d3ce', text: '#23281e', muted: '#5d6257', accent: '#b34a00', onAccent: '#fff', ink: '#a84500', hi: '#d3ddc7', onHi: '#23281e', glow: '#9caf88', c30: '#9caf88' },
    dark: { bg: '#1d2219', side: '#181c15', card: '#283022', raised: '#36412d', line: '#39412f', text: '#eef1e8', muted: '#b5bdaa', accent: '#c24e00', onAccent: '#fff', ink: '#f08a4b', hi: '#9caf88', onHi: '#1d2219', glow: '#cc5500', c30: '#a7a7a7' },
  },
  {
    id: 'atlas',
    swatch: ['#b7d8f5', '#e10600', '#ffd700'],
    light: { bg: '#e6f1fc', side: '#cfe4f8', card: '#f9fcff', raised: '#b7d8f5', line: '#bfd6ec', text: '#0f2a44', muted: '#3f5c7a', accent: '#e10600', onAccent: '#fff', ink: '#c20500', hi: '#ffd700', onHi: '#0f2a44', glow: '#ffd700', c30: '#0f2a44' },
    dark: { bg: '#0e1b2a', side: '#0a1622', card: '#162739', raised: '#20374f', line: '#243a52', text: '#eef6fe', muted: '#b7d8f5', accent: '#e10600', onAccent: '#fff', ink: '#ff5a4e', hi: '#ffd700', onHi: '#0e1b2a', glow: '#b7d8f5', c30: '#b7d8f5' },
  },
];
