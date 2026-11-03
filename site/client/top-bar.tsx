import React from 'react';
import type { EnfSignature } from '../../src/schemas';
import * as styles from '../styles.css';
import { LogoMark } from './icons';
import type { OfflineStatus } from './offline-status';

/** How the connection state reads in the bar: a dot colour and its words. */
interface ConnectionState {
  readonly label: string;
  readonly tone: 'ok' | 'busy' | 'warn' | 'bad';
}

/**
 * Words the offline state for the status chip.
 * @param status - What the offline hook reports.
 * @returns The label and the tone of its dot.
 */
export function describeConnection(status: Readonly<OfflineStatus>): ConnectionState {
  if (status.support === 'unavailable') {
    return { label: 'Offline use unavailable', tone: 'bad' };
  }
  if (status.support === 'preparing') {
    return { label: 'Preparing offline use', tone: 'busy' };
  }

  return status.online ? { label: 'Offline ready', tone: 'ok' } : { label: 'Offline: stored map tiles only', tone: 'warn' };
}

/** Properties of the top bar. */
export interface TopBarProps {
  readonly offline: Readonly<OfflineStatus>;
  readonly enf: Readonly<EnfSignature> | undefined;
}

/**
 * The single-row bar at the top: the product name on the left and, on the right, the grid frequency once detected and the offline state.
 * The offline state shrinks to its dot on a narrow screen, with its words still available to assistive technology.
 * @param props - What the component draws and the handlers it calls: offline, enf.
 * @returns The header element.
 */
export function TopBar(props: Readonly<TopBarProps>): React.JSX.Element {
  const { offline, enf } = props;
  const connection = describeConnection(offline);

  return (
    <header className={styles.topBar}>
      <div className={styles.brand}>
        <LogoMark size={22} />
        <span className={styles.brandName}>Doppler</span>
        <span className={styles.tagline}>Aircraft Acoustic Geolocation</span>
      </div>
      <div className={styles.topBarStatus}>
        {enf?.detected === true && <span className={styles.chip}>{`ENF ${enf.nominalHz} Hz grid`}</span>}
        <span className={styles.chip} title={connection.label}>
          <span className={styles.dot} data-tone={connection.tone} aria-hidden="true" />
          <span className={styles.chipLabel}>{connection.label}</span>
        </span>
      </div>
    </header>
  );
}
