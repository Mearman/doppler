import React from 'react';

/** Properties every icon takes. */
export interface IconProps {
  readonly size?: number;
}

/** Edge length of an icon in pixels unless the caller gives one. */
const DEFAULT_ICON_SIZE = 20;

/** Drawing grid the icon paths are written on. */
const VIEWBOX = '0 0 24 24';

function Icon({ size = DEFAULT_ICON_SIZE, children }: Readonly<IconProps & { children: React.ReactNode }>): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function MicIcon(props: Readonly<IconProps>): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </Icon>
  );
}

export function FileIcon(props: Readonly<IconProps>): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 14h6M9 17h4" />
    </Icon>
  );
}

export function TargetIcon(props: Readonly<IconProps>): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Icon>
  );
}

export function SessionIcon(props: Readonly<IconProps>): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </Icon>
  );
}

export function MapIcon(props: Readonly<IconProps>): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14" />
    </Icon>
  );
}

export function WaveIcon(props: Readonly<IconProps>): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 12h2l2-6 3 12 3-9 2 5 2-2h4" />
    </Icon>
  );
}

/** The mark beside the product name: a Doppler-compressed wave front that tightens towards the right. */
export function LogoMark({ size = DEFAULT_ICON_SIZE }: Readonly<IconProps>): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox={VIEWBOX} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M4 6c-2 3.5-2 8.5 0 12M9 4c-3 4.5-3 11.5 0 16M14 3c-3.5 5.5-3.5 12.5 0 18M18.5 8c-1.5 2.5-1.5 5.5 0 8" />
    </svg>
  );
}
