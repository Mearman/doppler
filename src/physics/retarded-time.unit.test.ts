import { describe, expect, it } from 'vitest';
import { solveRetardedDelaySec } from './retarded-time';

/** Decimal places `toBeCloseTo` compares the propagation distance to (a tolerance of 0.00005 m). */
const DISTANCE_COMPARE_DIGITS = 4;

describe('solveRetardedDelaySec', () => {
  it('solves exact closed-form Liénard-Wiechert quadratic propagation delay', () => {
    const c = 340.0;
    // 68 m/s along x
    const velocity = { x: 68.0, y: 0.0, z: 0.0 };

    // Aircraft at reception time t_obs is at x = 1000m, y = 500m
    const deltaPos = { x: 1000.0, y: 500.0, z: 0.0 };
    const delay = solveRetardedDelaySec(deltaPos, velocity, c);

    // Verify: position at emission time is r(t_emit) = deltaPos - velocity * delay
    const emitX = deltaPos.x - velocity.x * delay;
    const emitDist = Math.hypot(emitX, deltaPos.y, deltaPos.z);
    expect(delay * c).toBeCloseTo(emitDist, DISTANCE_COMPARE_DIGITS);
  });
});
