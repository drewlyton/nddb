import { isJsonObject } from "./json.js";

/**
 * Applies an RFC 7386 JSON Merge Patch to a target.
 *
 * Pure: returns a fresh object and mutates neither argument. Nothing is
 * deep-cloned, so untouched target subtrees and non-object patch values
 * (arrays included) are shared with the caller by reference.
 */

export const merge = (target: unknown, patch: unknown): unknown => {
  // Anything that is not an object replaces the target wholesale. That
  // includes null and arrays: RFC 7386 treats both as opaque values, so a
  // patch can never reach inside an array to change one element.
  if (!isJsonObject(patch)) {
    return patch;
  }

  const base = isJsonObject(target) ? target : {};
  const merged = new Map<string, unknown>(Object.entries(base));

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      // A null at a member position removes the member.
      merged.delete(key);
    } else {
      // Read the current value through the Map, never `base[key]`. Object
      // entries are own and enumerable only, so inherited names are never
      // traversed — the Map is what keeps `__proto__` and `constructor` data.
      merged.set(key, merge(merged.get(key), value));
    }
  }

  // Object.fromEntries assigns with CreateDataProperty, so `__proto__`,
  // `constructor`, and `prototype` become ordinary own data keys. `Object.assign`
  // would use [[Set]] and retarget the result's prototype instead.
  //
  // Recursion mirrors the patch's object nesting and is bounded by the call
  // stack, exactly like JSON.stringify; there is deliberately no depth guard.
  return Object.fromEntries(merged);
};
