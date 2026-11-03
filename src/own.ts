/**
 * Reads an own property of a record keyed by strings that come from data. A plain `record[key]` read follows the prototype chain, so a key such as `constructor` would find an inherited function instead of reporting absence.
 * @param record - The record to read.
 * @param key - Any string.
 * @returns The own property's value, or `undefined` when the record has no such own property.
 */
export function getOwn<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
