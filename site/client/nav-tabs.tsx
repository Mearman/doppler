import React from 'react';
import * as styles from '../styles.css';
import { FileIcon, MicIcon, SessionIcon, TargetIcon } from './icons';

/** Each destination in the side panel, in the order the bar shows them. */
export const NAV_ITEMS = [
  { id: 'listen', label: 'Listen', Icon: MicIcon },
  { id: 'file', label: 'File', Icon: FileIcon },
  { id: 'result', label: 'Result', Icon: TargetIcon },
  { id: 'session', label: 'Session', Icon: SessionIcon },
] as const;

export type NavId = (typeof NAV_ITEMS)[number]['id'];

/** Properties of the navigation bar. */
export interface NavTabsProps {
  readonly active: NavId;
  readonly onChange: (id: NavId) => void;
  /** Marks the result tab when an estimate exists. */
  readonly hasResult: boolean;
}

/** DOM id of the tab button for a destination, which its panel names as its label. */
export function tabId(id: NavId): string {
  return `tab-${id}`;
}

/** DOM id of the panel for a destination. */
export function panelId(id: NavId): string {
  return `panel-${id}`;
}

/**
 * The side panel's navigation: a row of tabs above the panel on a wide screen and a bar at the foot of the screen on a phone.
 * Arrow keys move between tabs, as the tabs pattern expects.
 * @param props - What the component draws and the handlers it calls: active, onChange, hasResult.
 * @returns The tab list.
 */
export function NavTabs(props: Readonly<NavTabsProps>): React.JSX.Element {
  const { active, onChange, hasResult } = props;
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) {
      return;
    }
    const index = NAV_ITEMS.findIndex((item) => item.id === active);
    const next = NAV_ITEMS[(index + step + NAV_ITEMS.length) % NAV_ITEMS.length];
    if (next !== undefined) {
      event.preventDefault();
      onChange(next.id);
      document.getElementById(tabId(next.id))?.focus();
    }
  };

  return (
    <div className={styles.nav} role="tablist" aria-label="Sections" onKeyDown={handleKeyDown}>
      {NAV_ITEMS.map(({ id, label, Icon }) => (
        <button
          key={id}
          id={tabId(id)}
          type="button"
          role="tab"
          aria-selected={active === id}
          aria-controls={panelId(id)}
          tabIndex={active === id ? 0 : -1}
          className={styles.navTab}
          data-active={active === id}
          onClick={() => {
            onChange(id);
          }}
        >
          <Icon size={20} />
          <span>{label}</span>
          {id === 'result' && hasResult && <span className={styles.navBadge} aria-label="estimate available" />}
        </button>
      ))}
    </div>
  );
}
