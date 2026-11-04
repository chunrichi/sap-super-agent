// Node requirement shared with the root package.json: `^22.19.0 || >=24.0.0`.
export const NODE_REQUIREMENT = '^22.19.0 || >=24.0.0';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export function parseNodeVersion(version: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return undefined;
  }
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  const patch = Number.parseInt(match[3] ?? '', 10);
  if (![major, minor, patch].every((value) => Number.isInteger(value) && value >= 0)) {
    return undefined;
  }
  return { major, minor, patch, raw: version.trim() };
}

/**
 * True when the version satisfies `^22.19.0 || >=24.0.0` (the range abap-cli
 * and the control plane need). Node 23 is intentionally rejected.
 */
export function satisfiesNodeRequirement(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (parsed === undefined) {
    return false;
  }
  if (parsed.major === 22) {
    return parsed.minor > 19 || (parsed.minor === 19 && parsed.patch >= 0);
  }
  return parsed.major >= 24;
}
