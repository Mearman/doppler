import { globalStyle, style } from '@vanilla-extract/css';

globalStyle('html, body, #root', {
  margin: 0,
  padding: 0,
  width: '100%',
  height: '100%',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  backgroundColor: '#121214',
  color: '#e1e1e6',
});

export const appContainer = style({
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  overflow: 'hidden',
});

export const header = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 24px',
  borderBottom: '1px solid #282830',
  backgroundColor: '#18181c',
});

export const mainContent = style({
  display: 'flex',
  flex: 1,
  overflow: 'hidden',
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
});

export const mapPanel = style({
  flex: 1,
  height: '100%',
  position: 'relative',
  backgroundColor: '#101012',
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
