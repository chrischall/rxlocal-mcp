// Small shared helpers for the patient-data tools: the READ annotation and safe
// coercions for the loosely typed RxLocal payloads.

import { toolAnnotations } from '@chrischall/mcp-utils';

/**
 * The annotation the patient-data READ tools share: they read the live portal
 * and change nothing. `destructive: false` is passed explicitly so the hint is
 * a BOOLEAN rather than omitted.
 */
export const READ = toolAnnotations({ readOnly: true, destructive: false, openWorld: true });

/** A value as a plain object, or `{}` — never an array, never null. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A value as an array of plain objects, dropping anything that is not one. */
export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v),
  );
}

/**
 * Drop null, undefined and empty-string values so a compact record stays
 * compact. `false` and `0` are kept — they are answers, not absences.
 */
export function tidy(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/** The portal's `PickupType` enum (from the SPA bundle). */
export const CONVEYANCE = { pickup: 1, delivery: 2, mail: 3 } as const;
export type ConveyanceName = keyof typeof CONVEYANCE;

/** The portal's `PickupTimeType` enum (from the SPA bundle). */
export const PICKUP_TIME = { asap: 1, later_today: 2, tomorrow: 3, later: 4 } as const;
export type PickupTimeName = keyof typeof PICKUP_TIME;

/** The name of an enum value, or `undefined` for one this server does not know. */
export function enumName<T extends Record<string, number>>(table: T, value: unknown): keyof T | undefined {
  return (Object.keys(table) as (keyof T)[]).find((k) => table[k] === value);
}
