import type { z } from 'zod';

/**
 * A Zod schema that also carries the schema-attached type guard `is`.
 */
type Guarded<T extends z.ZodType> = T & {
  readonly is: (value: unknown) => value is z.infer<T>;
};

/**
 * Reports whether a schema carries a callable `is` property, which narrows it to its guarded type without a type assertion.
 * @param candidate - The schema to inspect.
 * @returns True when `candidate` has an own `is` function.
 */
function isGuarded<T extends z.ZodType>(candidate: T): candidate is Guarded<T> {
  return Object.hasOwn(candidate, 'is') && 'is' in candidate && typeof candidate.is === 'function';
}

/**
 * Attaches a type guard to a Zod schema (the schema-attached guard pattern: validation, inference and narrowing share one definition, so the three cannot drift). The guard is defined on the schema object itself, because a Zod 4 schema keeps its methods on its prototype and its parse state on `_zod`: a spread copy loses the methods, so it could no longer be parsed or nested in another schema.
 * @param schema - The schema to augment.
 * @returns The same schema object, now also carrying `is`.
 * @throws When the schema is non-extensible, so the guard cannot be attached, or when the property was not installed.
 */
export function define<T extends z.ZodType>(schema: T): Guarded<T> {
  const augmented = Object.defineProperty(schema, 'is', {
    enumerable: true,
    value: (value: unknown): value is z.infer<T> => schema.safeParse(value).success,
  });

  if (!isGuarded(augmented)) {
    throw new TypeError('define: the type guard was not installed on the schema');
  }

  return augmented;
}
