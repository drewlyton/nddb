/** An object as JSON.parse produces them: not null, not an array. */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Why `JSON.stringify` would drop, mangle, or refuse a value. */
export type NonJsonReason =
  | "undefined"
  | "function"
  | "symbol"
  | "bigint"
  | "non-finite number"
  | "cycle";

/** A value the write path cannot represent, and where it sits in the payload. */
export type NonJsonViolation = {
  readonly path: readonly (string | number)[];
  readonly reason: NonJsonReason;
};

const primitiveReason = (value: unknown): NonJsonReason | undefined => {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "function") {
    return "function";
  }
  if (typeof value === "symbol") {
    return "symbol";
  }
  if (typeof value === "bigint") {
    return "bigint";
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return "non-finite number";
  }
  return undefined;
};

/**
 * First value JSON cannot represent, with its path from the root.
 *
 * The write path rejects these before serialising: `JSON.stringify` drops
 * `undefined`, functions, and symbols, rewrites `NaN`/`Infinity` to `null`,
 * throws on `BigInt`, and loops on cycles.
 */
export const findNonJson = (root: unknown): NonJsonViolation | undefined => {
  const ancestors = new Set<object>();

  const walk = (
    value: unknown,
    path: readonly (string | number)[],
  ): NonJsonViolation | undefined => {
    const reason = primitiveReason(value);
    if (reason !== undefined) {
      return { path, reason };
    }
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    // A shared reference is serialisable; only a value containing itself is not.
    if (ancestors.has(value)) {
      return { path, reason: "cycle" };
    }
    ancestors.add(value);

    let found: NonJsonViolation | undefined;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && found === undefined; index += 1) {
        found = walk(value[index], [...path, index]);
      }
    } else {
      for (const [key, child] of Object.entries(value)) {
        found = walk(child, [...path, key]);
        if (found !== undefined) {
          break;
        }
      }
    }

    ancestors.delete(value);
    return found;
  };

  return walk(root, []);
};
