import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { define } from './define';

const PointSchema = define(z.object({ x: z.number(), y: z.number() }));
const VALID_POINT = { x: 1, y: 2 };
const INVALID_POINT = { x: 1 };

describe('define', () => {
  it('returns the schema object itself, still parsing', () => {
    const base = z.object({ x: z.number() });
    const guarded = define(base);

    expect(guarded).toBe(base);
    expect(guarded.parse({ x: 1 })).toEqual({ x: 1 });
    expect(() => guarded.parse({})).toThrow();
  });

  it('attaches a guard that agrees with safeParse', () => {
    expect(PointSchema.is(VALID_POINT)).toBe(true);
    expect(PointSchema.is(INVALID_POINT)).toBe(false);
    expect(PointSchema.is(null)).toBe(false);
  });

  it('narrows a value through the guard', () => {
    const sum = (candidate: unknown): number => {
      if (!PointSchema.is(candidate)) {
        throw new Error('expected the candidate to satisfy the guard');
      }

      return candidate.x + candidate.y;
    };

    expect(sum(VALID_POINT)).toBe(VALID_POINT.x + VALID_POINT.y);
    expect(() => sum(INVALID_POINT)).toThrow('expected the candidate');
  });

  it('nests inside arrays, objects, optionals and readonly wrappers', () => {
    const list = z.array(PointSchema).readonly();
    const wrapper = z.object({ child: PointSchema, maybe: PointSchema.optional() });

    expect(list.parse([VALID_POINT])).toEqual([VALID_POINT]);
    expect(Object.isFrozen(list.parse([VALID_POINT]))).toBe(true);
    expect(wrapper.parse({ child: VALID_POINT })).toEqual({ child: VALID_POINT });
    expect(() => wrapper.parse({ child: INVALID_POINT })).toThrow();
  });

  it('guards a schema without an object shape', () => {
    const KindSchema = define(z.enum(['a', 'b']));

    expect(KindSchema.is('a')).toBe(true);
    expect(KindSchema.is('c')).toBe(false);
  });

  it('fails loudly when the schema cannot be extended', () => {
    expect(() => define(Object.freeze(z.string()))).toThrow(TypeError);
  });

  it('fails loudly when the guard was not installed', () => {
    const swallowing = new Proxy(z.string(), { defineProperty: () => true });

    expect(() => define(swallowing)).toThrow('the type guard was not installed');
  });
});
