import { createHash } from 'node:crypto';
import { v7 as uuidv7, validate as uuidValidate } from 'uuid';

/** Time-ordered, collision-resistant identifiers (RFC 9562 UUIDv7). */
export const newId = (): string => uuidv7();
export const isUuid = (s: string): boolean => uuidValidate(s);

/** Deterministic JSON: object keys sorted recursively, so semantically equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
