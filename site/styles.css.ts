import { globalStyle, style } from '@vanilla-extract/css';

/** Viewport width below which the sidebar stacks under the map and spectrogram instead of sitting beside them. Mantine's own `md` breakpoint (62em), rounded to the width at which a 340px sidebar leaves the map under 520px. */
const STACK_BELOW = 'screen and (max-width: 860px)';

/** The smallest touch target that WCAG 2.5.5 and the platform guidelines agree on, in pixels. */
const TOUCH_TARGET_PX = 44;

/** Share of the viewport height the map and spectrogram keep when the layout is stacked. */
const STACKED_VISUALIZER_HEIGHT = '48dvh';

globalStyle('html, body, #root', {
  margin: 0,
  padding: 0,
  width: '100%',
  height: '100%',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  backgroundColor: '#121214',
  color: '#e1e1e6',
});

globalStyle('button, [role="tab"], a, input, select', {
  '@media': {
    '(pointer: coarse)': { minHeight: `${String(TOUCH_TARGET_PX)}px` },
  },
});

// Leaflet's zoom buttons are 30px wide on any pointer; a finger needs the full target.
globalStyle('.leaflet-bar a', {
  '@media': {
    '(pointer: coarse)': { width: `${String(TOUCH_TARGET_PX)}px`, height: `${String(TOUCH_TARGET_PX)}px`, lineHeight: `${String(TOUCH_TARGET_PX)}px` },
  },
});

globalStyle('*, *::before, *::after', {
  '@media': {
    '(prefers-reduced-motion: reduce)': { animationDuration: '0.01ms', animationIterationCount: 1, transitionDuration: '0.01ms', scrollBehavior: 'auto' },
  },
});

export const appContainer = style({
  display: 'flex',
  flexDirection: 'column',
  // dvh follows the visible viewport as a mobile browser's address bar shows and hides, which vh does not; the fallback line covers browsers without it.
  height: '100vh',
  overflow: 'hidden',
  paddingLeft: 'env(safe-area-inset-left)',
  paddingRight: 'env(safe-area-inset-right)',
  paddingBottom: 'env(safe-area-inset-bottom)',
  '@supports': { '(height: 100dvh)': { height: '100dvh' } },
  '@media': {
    [STACK_BELOW]: { height: 'auto', minHeight: '100dvh', overflow: 'visible' },
  },
});

export const header = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: '8px 16px',
  padding: '12px 24px',
  paddingTop: 'max(12px, env(safe-area-inset-top))',
  '@media': { [STACK_BELOW]: { padding: '8px 16px' } },
  borderBottom: '1px solid #282830',
  backgroundColor: '#18181c',
});

/** The tagline beside the product name, which a phone's header has no room for. */
export const tagline = style({
  '@media': { [STACK_BELOW]: { display: 'none' } },
});

/** The estimated location, which sits at the foot of the sidebar beside the map and moves above the controls when stacked, where a phone user sees the result without scrolling past them. */
export const resultCard = style({
  '@media': { [STACK_BELOW]: { order: -1, marginTop: 0 } },
});

export const mainContent = style({
  display: 'flex',
  flex: 1,
  overflow: 'hidden',
  '@media': { [STACK_BELOW]: { flexDirection: 'column', overflow: 'visible' } },
});

export const sidebar = style({
  width: '380px',
  minWidth: '340px',
  maxWidth: '440px',
  borderRight: '1px solid #282830',
  padding: '16px',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  backgroundColor: '#16161a',
  '@media': {
    [STACK_BELOW]: { width: '100%', minWidth: 0, maxWidth: 'none', borderRight: 'none', overflowY: 'visible', padding: '12px 16px' },
  },
});

export const visualizerPanel = style({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
  backgroundColor: '#101012',
  '@media': {
    // Stacked, the map and spectrogram come first and stay in view while the controls below scroll past them.
    [STACK_BELOW]: { order: -1, flex: 'none', height: STACKED_VISUALIZER_HEIGHT, position: 'sticky', top: 0, zIndex: 400, borderBottom: '1px solid #282830' },
  },
});

export const mapContainer = style({
  flex: 1,
  minHeight: '220px',
  position: 'relative',
});

export const spectrogramSection = style({
  height: '240px',
  minHeight: '160px',
  '@media': { [STACK_BELOW]: { height: '38%', minHeight: '110px' } },
  borderTop: '1px solid #282830',
  backgroundColor: '#121216',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
});

export const spectrogramHeader = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '6px 14px',
  backgroundColor: '#16161b',
  borderBottom: '1px solid #23232c',
});

export const canvasWrapper = style({
  flex: 1,
  position: 'relative',
  overflow: 'hidden',
  backgroundColor: '#0a0a0e',
});

export const fullCanvas = style({
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  display: 'block',
});

export const waterfallCanvas = style({
  width: '100%',
  height: '140px',
  borderRadius: '6px',
  border: '1px solid #2e2e38',
  backgroundColor: '#0a0a0c',
});

export const episodeBadge = style({
  padding: '4px 8px',
  borderRadius: '4px',
  fontSize: '12px',
  fontWeight: 600,
});
