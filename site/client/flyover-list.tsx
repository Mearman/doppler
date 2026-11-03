import React from 'react';
import type { DopplerObservation } from '../../src/schemas';
import * as styles from '../styles.css';

/** Properties of the flyover list. */
export interface FlyoverListProps {
  readonly observations: readonly DopplerObservation[];
}

/**
 * Lists the flyovers the analysis found, one line each, in the order they were found.
 * @param props - What the component draws and the handlers it calls: observations.
 * @returns A labelled list, or a sentence saying none were found.
 */
export function FlyoverList(props: Readonly<FlyoverListProps>): React.JSX.Element {
  const { observations } = props;
  if (observations.length === 0) {
    return <p className={styles.muted}>No aircraft flyovers detected yet.</p>;
  }

  return (
    <ol className={styles.flyoverList} aria-label="Detected flyovers">
      {observations.map((observation, index) => (
        <li key={observation.id} className={styles.flyoverItem}>
          <span className={styles.flyoverIndex}>{`#${String(index + 1)}`}</span>
          <span>{`${observation.kinematics.baseFreqHz.toFixed(1)} Hz`}</span>
          <span>{`${observation.kinematics.inferredSpeedMps.toFixed(1)} m/s`}</span>
          <span className={styles.muted}>{`${observation.snrDb.toFixed(0)} dB SNR`}</span>
        </li>
      ))}
    </ol>
  );
}
