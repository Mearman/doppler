import { describe, expect, it } from 'vitest';
import { detectEnfSignature } from './side-channels';

describe('side-channels', () => {
  it('detects 50 Hz European ENF hum', () => {
    const sampleRateHz = 2000;
    const durationSec = 3.0;
    const n = Math.floor(sampleRateHz * durationSec);
    const audio = new Float32Array(n);

    // Add 50 Hz tone with noise
    for (let i = 0; i < n; i += 1) {
      audio[i] = 0.2 * Math.sin((2 * Math.PI * 50 * i) / sampleRateHz) + 0.01 * (Math.random() - 0.5);
    }

    const enf = detectEnfSignature(audio, sampleRateHz);
    expect(enf.detected).toBe(true);
    expect(enf.nominalHz).toBe('50');
    expect(enf.snrDb).toBeGreaterThan(10);
  });
});
