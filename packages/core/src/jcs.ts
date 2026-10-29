// RFC 8785 JSON Canonicalization Scheme.
// Fails closed: anything that is not plain JSON data (undefined, NaN, Infinity,
// bigint, functions, Dates, Maps, class instances, lone surrogates) throws
// instead of being dropped or coerced, so two parties can never hash different
// interpretations of the same value. Pass only JSON.parse or zod-parsed data:
// getters and non-enumerable properties are not canonicalizable.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new TypeError("jcs: lone surrogate in string");
  // JSON.stringify escapes exactly as RFC 8785 §3.2.2.2 requires.
  return JSON.stringify(s);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError("jcs: non-finite number");
  // ECMAScript Number.prototype.toString is the RFC 8785 §3.2.2.3 algorithm; -0 becomes "0".
  return JSON.stringify(n);
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function serialize(v: unknown, seen: Set<object>): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return serializeNumber(v);
    case "string":
      return serializeString(v);
    case "object":
      break;
    default:
      throw new TypeError(`jcs: unsupported type ${typeof v}`);
  }
  if (seen.has(v)) throw new TypeError("jcs: circular reference");
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const parts: string[] = [];
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) throw new TypeError("jcs: sparse array");
        parts.push(serialize(v[i], seen));
      }
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(v)) throw new TypeError("jcs: non-plain object");
    if (Object.getOwnPropertySymbols(v).length > 0) throw new TypeError("jcs: symbol key");
    // Default string sort compares UTF-16 code units, as §3.2.3 requires.
    const keys = Object.keys(v).sort();
    const rec = v as Record<string, unknown>;
    const parts = keys.map((k) => `${serializeString(k)}:${serialize(rec[k], seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(v);
  }
}

export function jcs(value: unknown): string {
  return serialize(value, new Set());
}

export function jcsBytes(value: unknown): Buffer {
  return Buffer.from(jcs(value), "utf8");
}
