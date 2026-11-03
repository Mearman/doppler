import type { z } from 'zod';

/**
 * Attaches a type guard to a Zod schema (the schema-attached guard pattern: validation, inference and narrowing share one definition, so the three cannot drift). This module is isolated because it is the one place in the package that augments an object in place with Object.assign, which the house lint rule that eslint.config.ts turns off for this file alone would otherwise reject: object spread is no alternative, as it copies own properties only and drops the Zod prototype's parse/refine methods.
 * @param schema - The schema to augment.
 * @returns The same schema object, now also carrying `is`.
 */
export function define<T extends z.ZodType>(schema: T): T & {
  readonly is: (value: unknown) => value is z.infer<T>;
} {
  return Object.assign(schema, {
    is(value: unknown): value is z.infer<T> {
      return schema.safeParse(value).success;
    },
  });
}
