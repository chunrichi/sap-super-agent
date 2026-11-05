/** SQLite row accessors: node:sqlite returns string | number | bigint | null | Uint8Array. */

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export function asString(value: unknown): string {
  return String(value);
}

export function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function asNumber(value: unknown): number {
  return Number(value);
}

export function asBoolean(value: unknown): boolean {
  return Number(value) === 1;
}
