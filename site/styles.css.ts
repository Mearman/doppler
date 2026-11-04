import { createGlobalTheme, globalStyle, style } from '@vanilla-extract/css';

/** Viewport width at and below which the sidebar stacks under the stage and the section tabs move to the foot of the screen. */
const PHONE = 'screen and (max-width: 860px)';

/** Viewport width above the phone layout, one pixel past `PHONE` so that exactly one of the two applies. */
const DESKTOP = 'screen and (min-width: 861px)';

/** The smallest touch target that WCAG 2.5.5 and the platform guidelines agree on, in pixels. */
const TOUCH_TARGET_PX = 44;

/** Share of the viewport height the stage (map or spectrogram) keeps when the layout is stacked. */
const PHONE_STAGE_HEIGHT = '44dvh';

/** Height of the spectrogram beside the map on a wide screen, collapsed and expanded, in pixels. */
const SPECTROGRAM_HEIGHT_PX = 270;
const SPECTROGRAM_EXPANDED_HEIGHT_PX = 440;

/** Design tokens, defined once so the surfaces, text and accents stay consistent. Muted text is at least 4.5:1 against every surface it sits on. */
export const vars = createGlobalTheme(':root', {
  color: {
    background: '#0f0f13',
    surface: '#17171c',
    raised: '#1e1e25',
    border: '#2a2a34',
    text: '#e6e6ee',
    muted: '#a3a3b8',
    accent: '#60a5fa',
    ok: '#34d399',
    busy: '#fbbf24',
    warn: '#fb923c',
    bad: '#f87171',
  },
  radius: { card: '10px', chip: '999px' },
  space: { gutter: '16px' },
});

globalStyle('html, body, #root', {
  margin: 0,
  padding: 0,
  width: '100%',
  height: '100%',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  backgroundColor: vars.color.background,
  color: vars.color.text,
});

globalStyle('button, [role="tab"], a, input, select', {
  '@media': {
    '(pointer: coarse)': { minHeight: `${String(TOUCH_TARGET_PX)}px` },
  },
});

// Leaflet's zoom buttons are 30px wide on any pointer; a finger needs the full target.
globalStyle('.leaflet-container .leaflet-control-attribution a', { textDecoration: 'underline', color: '#004466' });

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

// A keyboard user always sees where focus is; the ring is the accent and clears every surface.
globalStyle(':focus-visible', { outline: `2px solid ${vars.color.accent}`, outlineOffset: 2 });

export const app = style({
  display: 'flex',
  flexDirection: 'column',
  // dvh follows the visible viewport as a mobile browser's address bar shows and hides, which vh does not; the fallback line covers browsers without it.
  height: '100vh',
  overflow: 'hidden',
  paddingLeft: 'env(safe-area-inset-left)',
  paddingRight: 'env(safe-area-inset-right)',
  '@supports': { '(height: 100dvh)': { height: '100dvh' } },
});

export const topBar = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'nowrap',
  gap: 12,
  minHeight: 48,
  padding: `max(0px, env(safe-area-inset-top)) ${vars.space.gutter} 0`,
  borderBottom: `1px solid ${vars.color.border}`,
  backgroundColor: vars.color.surface,
});

export const brand = style({ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, color: vars.color.accent });

export const brandName = style({ fontSize: 18, fontWeight: 700 });

/** The tagline beside the product name, which a phone's bar has no room for. */
export const tagline = style({
  color: vars.color.muted,
  fontSize: 14,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  '@media': { [PHONE]: { display: 'none' } },
});

export const topBarStatus = style({ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 });

export const chip = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 26,
  padding: '0 10px',
  borderRadius: vars.radius.chip,
  border: `1px solid ${vars.color.border}`,
  backgroundColor: vars.color.raised,
  color: vars.color.text,
  fontSize: 12,
  whiteSpace: 'nowrap',
});

/** The words of a status chip. On a phone only its dot shows; the words stay for assistive technology. */
export const chipLabel = style({
  '@media': {
    [PHONE]: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
  },
});

export const dot = style({
  width: 8,
  height: 8,
  borderRadius: '50%',
  backgroundColor: vars.color.muted,
  selectors: {
    '&[data-tone="ok"]': { backgroundColor: vars.color.ok },
    '&[data-tone="busy"]': { backgroundColor: vars.color.busy },
    '&[data-tone="warn"]': { backgroundColor: vars.color.warn },
    '&[data-tone="bad"]': { backgroundColor: vars.color.bad },
  },
});

export const banner = style({ margin: '8px 12px 0', flexShrink: 0 });

export const bannerBody = style({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 14 });

export const workspace = style({
  display: 'flex',
  flex: 1,
  minHeight: 0,
  '@media': { [PHONE]: { flexDirection: 'column' } },
});

export const sidebar = style({
  display: 'flex',
  flexDirection: 'column',
  width: 380,
  flexShrink: 0,
  minHeight: 0,
  borderRight: `1px solid ${vars.color.border}`,
  backgroundColor: vars.color.surface,
  '@media': {
    [PHONE]: { width: '100%', flex: 1, borderRight: 'none', paddingBottom: 'env(safe-area-inset-bottom)' },
  },
});

/** Section tabs: a row above the panel on a wide screen, a bar at the foot of the screen on a phone. */
export const nav = style({
  display: 'flex',
  borderBottom: `1px solid ${vars.color.border}`,
  '@media': { [PHONE]: { order: 2, borderBottom: 'none', borderTop: `1px solid ${vars.color.border}`, backgroundColor: vars.color.surface } },
});

export const navTab = style({
  position: 'relative',
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 2,
  minHeight: 52,
  padding: '6px 4px',
  border: 'none',
  borderBottom: '2px solid transparent',
  background: 'none',
  color: vars.color.muted,
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  selectors: {
    '&[data-active="true"]': { color: vars.color.accent, borderBottomColor: vars.color.accent },
  },
  '@media': {
    [PHONE]: { minHeight: 56, borderBottom: 'none', borderTop: '2px solid transparent' },
  },
});

globalStyle(`${navTab}[data-active="true"]`, { '@media': { [PHONE]: { borderBottomColor: 'transparent', borderTopColor: vars.color.accent } } });

export const navBadge = style({ position: 'absolute', top: 8, right: '28%', width: 8, height: 8, borderRadius: '50%', backgroundColor: vars.color.ok });

export const panel = style({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: vars.space.gutter,
});

export const panelStack = style({ display: 'flex', flexDirection: 'column', gap: 12 });

export const card = style({
  padding: 14,
  borderRadius: vars.radius.card,
  border: `1px solid ${vars.color.border}`,
  backgroundColor: vars.color.raised,
});

export const cardTitle = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  margin: '0 0 10px',
  color: vars.color.muted,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
});

export const buttonRow = style({ display: 'flex', gap: 8, marginBottom: 10 });

export const row = style({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 14 });

export const hint = style({ margin: '0 0 10px', color: vars.color.muted, fontSize: 13, lineHeight: 1.45 });

export const muted = style({ color: vars.color.muted, fontSize: 13 });

export const mono = style({ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, overflowWrap: 'anywhere' });

export const headline = style({ margin: '0 0 8px', fontSize: 18, fontWeight: 600, lineHeight: 1.35 });

export const link = style({ color: vars.color.accent, fontSize: 14 });

export const definitionList = style({
  display: 'grid',
  gridTemplateColumns: 'max-content 1fr',
  gap: '8px 14px',
  margin: 0,
  fontSize: 13,
  lineHeight: 1.4,
});

globalStyle(`${definitionList} dt`, { color: vars.color.muted, fontWeight: 600 });
globalStyle(`${definitionList} dd`, { margin: 0 });

export const flyoverList = style({ display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' });

export const flyoverItem = style({ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 14, fontVariantNumeric: 'tabular-nums' });

export const flyoverIndex = style({ color: vars.color.accent, fontWeight: 700 });

/** The file chooser, whose real input covers the whole zone so that clicking, dropping and keyboard focus all reach it. */
export const dropZone = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  minHeight: 120,
  padding: 16,
  textAlign: 'center',
  borderRadius: vars.radius.card,
  border: `2px dashed ${vars.color.border}`,
  selectors: {
    '&:focus-within': { borderColor: vars.color.accent },
    '&[data-disabled="true"]': { opacity: 0.6 },
  },
});

export const dropInput = style({ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' });

export const catalogue = style({ display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' });

export const catalogueItem = style({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 });

export const catalogueName = style({ display: 'flex', flexDirection: 'column', minWidth: 0, fontSize: 14 });

export const busy = style({ display: 'flex', flexDirection: 'column', gap: 6 });

export const busyText = style({ display: 'flex', flexDirection: 'column', margin: 0, fontSize: 13, color: vars.color.muted });

/** The map and spectrogram: stacked on a wide screen, one at a time on a phone. */
export const stage = style({
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: vars.color.background,
  '@media': {
    [PHONE]: { flex: 'none', height: PHONE_STAGE_HEIGHT, order: -1, borderBottom: `1px solid ${vars.color.border}` },
  },
});

export const stageSwitch = style({
  display: 'none',
  '@media': {
    [PHONE]: { display: 'flex', flexShrink: 0, gap: 6, padding: '6px 12px', borderBottom: `1px solid ${vars.color.border}`, backgroundColor: vars.color.surface },
  },
});

globalStyle(`${stageSwitch} button`, {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  flex: 1,
  minHeight: TOUCH_TARGET_PX,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.chip,
  background: 'none',
  color: vars.color.muted,
  font: 'inherit',
  fontSize: 13,
});

globalStyle(`${stageSwitch} button[aria-pressed="true"]`, { backgroundColor: vars.color.raised, color: vars.color.accent, borderColor: vars.color.accent });

export const stagePane = style({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  '@media': { [PHONE]: { selectors: { '&[data-hidden="true"]': { display: 'none' } } } },
});

/** On a wide screen the spectrogram sits under the map at a fixed height, which its expand control raises. */
export const spectrogramPane = style({
  '@media': {
    [DESKTOP]: {
      flex: 'none',
      height: SPECTROGRAM_HEIGHT_PX,
      borderTop: `1px solid ${vars.color.border}`,
      selectors: { '&:has([data-expanded="true"])': { height: SPECTROGRAM_EXPANDED_HEIGHT_PX } },
    },
  },
});

export const mapContainer = style({ position: 'relative', flex: 1, minHeight: 0 });

export const mapCanvas = style({ position: 'absolute', inset: 0 });

/** The estimate stated over the map, which opens the result when chosen. */
export const mapChip = style({
  position: 'absolute',
  left: 12,
  bottom: 12,
  zIndex: 800,
  maxWidth: 'calc(100% - 24px)',
  padding: '8px 12px',
  borderRadius: vars.radius.card,
  border: `1px solid ${vars.color.border}`,
  backgroundColor: vars.color.surface,
  color: vars.color.text,
  font: 'inherit',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
});

/** The control that centres the map on the device, top right so it does not cover the estimate chip at the bottom left. */
export const locateButton = style({
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 800,
  padding: '8px 12px',
  borderRadius: vars.radius.card,
  border: `1px solid ${vars.color.border}`,
  backgroundColor: vars.color.surface,
  color: vars.color.text,
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
});

export const spectrogramSection = style({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: vars.color.surface,
});

/** One row: mode, readout, legend and controls. The readout takes the space left and truncates rather than wrapping. */
export const spectrogramHeader = style({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'nowrap',
  gap: 10,
  minHeight: 36,
  padding: '4px 12px',
  borderBottom: `1px solid ${vars.color.border}`,
});

export const modeTag = style({
  flexShrink: 0,
  padding: '2px 8px',
  borderRadius: vars.radius.chip,
  backgroundColor: vars.color.raised,
  border: `1px solid ${vars.color.border}`,
  fontSize: 12,
  fontWeight: 600,
  selectors: {
    '&[data-mode="live"]': { color: vars.color.bad, borderColor: vars.color.bad },
    '&[data-mode="clip"]': { color: vars.color.accent, borderColor: vars.color.accent },
    '&[data-mode="idle"]': { color: vars.color.muted },
  },
});

export const readout = style({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: vars.color.muted,
});

export const legend = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: 110,
  flexShrink: 0,
  '@media': { [PHONE]: { display: 'none' } },
});

export const legendBar = style({ display: 'block', height: 6, borderRadius: 3 });

export const legendLabels = style({ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: vars.color.muted });

export const canvasWrapper = style({ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', backgroundColor: '#0a0a0f' });

export const fullCanvas = style({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'block', touchAction: 'pan-y' });

/** The empty state: ordinary wrapping text centred over the plot, so no width can clip it. */
export const canvasEmpty = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  margin: 0,
  padding: 24,
  textAlign: 'center',
  color: vars.color.muted,
  fontSize: 14,
  lineHeight: 1.4,
  pointerEvents: 'none',
});

export const crosshairV = style({ position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255, 255, 255, 0.35)', pointerEvents: 'none' });

export const crosshairH = style({ position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(255, 255, 255, 0.35)', pointerEvents: 'none' });

/** Enlarging the spectrogram only has meaning beside the map; the stacked layout fixes its height. */
export const expandButton = style({ '@media': { [PHONE]: { display: 'none' } } });
