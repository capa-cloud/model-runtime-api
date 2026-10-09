import { createHash } from "node:crypto";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (keys && Object.keys(result).some((key) => !keys.includes(key))) invalid();
  return result;
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) invalid();
  return value;
}

export function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
  return new Date(value).toISOString();
}

export function strings(value: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) invalid();
  const values = Array.from(value).map(identifier);
  if (
    new Set(values).size !== values.length ||
    (allowed && values.some((item) => !allowed.includes(item)))
  )
    invalid();
  return values.sort();
}

export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

export function invalid(): never {
  throw new Error("Invalid catalog data");
}
