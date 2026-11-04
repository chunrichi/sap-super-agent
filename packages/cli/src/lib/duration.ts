// Duration parsing for `--ttl` (e.g. `24h`, `90m`, `7d`). No dependencies.
export const DEFAULT_TTL = '24h';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse `30s` / `15m` / `24h` / `7d` into milliseconds. Returns `undefined` for
 * anything malformed so callers can raise one actionable CLI error.
 */
export function parseDurationMs(raw: string): number | undefined {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(raw.trim());
  if (match === null) {
    return undefined;
  }
  const amount = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const unit = (match[2] ?? 'ms').toLowerCase();
  const unitMs = UNIT_MS[unit];
  if (unitMs === undefined) {
    return undefined;
  }
  const value = amount * unitMs;
  return Number.isSafeInteger(value) ? value : undefined;
}

export function formatDurationMs(ms: number): string {
  if (ms % UNIT_MS['d']! === 0) return `${ms / UNIT_MS['d']!}d`;
  if (ms % UNIT_MS['h']! === 0) return `${ms / UNIT_MS['h']!}h`;
  if (ms % UNIT_MS['m']! === 0) return `${ms / UNIT_MS['m']!}m`;
  if (ms % UNIT_MS['s']! === 0) return `${ms / UNIT_MS['s']!}s`;
  return `${ms}ms`;
}
