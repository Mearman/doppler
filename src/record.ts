import { z } from 'zod';

/**
 * A record whose every key must satisfy `key`. Zod's own record silently drops an own `__proto__` key (which `JSON.parse` creates as an ordinary property) before the key schema sees it, so this checks the raw input first and rejects such a key loudly instead of losing the value.
 * @param key - The key schema.
 * @param value - The value schema.
 * @returns The record schema.
 */
export function recordOf<Value extends z.ZodType>(key: z.ZodString, value: Value): z.ZodPreprocess<z.ZodRecord<z.ZodString, Value>> {
  return z.preprocess((input, ctx) => {
    if (typeof input === 'object' && input !== null && Object.hasOwn(input, '__proto__')) {
      ctx.issues.push({ code: 'custom', input, message: '__proto__ is not a valid key' });
    }

    return input;
  }, z.record(key, value));
}
