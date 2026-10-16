import { isJsonObject } from "./json.js";

/** The three verbs of the log's closed grammar. */
export type ActionOp = "put" | "patch" | "delete";

export type PutAction = {
  readonly op: "put";
  readonly id: string;
  readonly value: Record<string, unknown>;
};

export type PatchAction = {
  readonly op: "patch";
  readonly id: string;
  readonly patch: Record<string, unknown>;
};

export type DeleteAction = {
  readonly op: "delete";
  readonly id: string;
};

/** A single action in the log. */
export type Action = PutAction | PatchAction | DeleteAction;

/** Where a rejected value sits in a payload: object keys and array indices. */
export type ActionPath = readonly (string | number)[];

export type ActionErrorCode =
  | "not-an-object"
  | "op-missing"
  | "op-unknown"
  | "id-missing"
  | "id-not-string"
  | "id-empty"
  | "value-missing"
  | "value-not-object"
  | "value-has-null"
  | "not-json"
  | "patch-missing"
  | "patch-not-object"
  | "patch-null-in-array";

export type ActionCheck =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly code: ActionErrorCode; readonly path?: ActionPath };

const fail = (code: ActionErrorCode, path?: ActionPath): ActionCheck =>
  path === undefined ? { ok: false, code } : { ok: false, code, path };

/** First `null` anywhere in a put payload, as a path from the payload root. */
const findNull = (value: unknown, path: ActionPath): ActionPath | undefined => {
  if (value === null) {
    return path;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findNull(value[index], [...path, index]);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const found = findNull(child, [...path, key]);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
};

/**
 * First `null` reached through an array in a patch.
 *
 * A `null` at an object-member position removes that member, so it is only a
 * grammar error once an array is in the path: arrays are opaque values, and a
 * stored `null` inside one would be unremovable.
 */
const findNullInArray = (
  value: unknown,
  path: ActionPath,
  inArray: boolean,
): ActionPath | undefined => {
  if (value === null) {
    return inArray ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findNullInArray(value[index], [...path, index], true);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const found = findNullInArray(child, [...path, key], inArray);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
};

/**
 * Validate a parsed JSON value against the action grammar.
 *
 * Returns a fresh minimal action on success; the caller's payload object is
 * reused by reference. On failure the code says why and, for a rejected
 * `null`, the path says where — Log reading needs both to report damage
 * precisely.
 */
export const classifyAction = (value: unknown): ActionCheck => {
  if (!isJsonObject(value)) {
    return fail("not-an-object");
  }

  const fields = new Map<string, unknown>(Object.entries(value));

  const op = fields.get("op");
  if (op === undefined) {
    return fail("op-missing");
  }
  if (op !== "put" && op !== "patch" && op !== "delete") {
    return fail("op-unknown");
  }

  const id = fields.get("id");
  if (id === undefined) {
    return fail("id-missing");
  }
  if (typeof id !== "string") {
    return fail("id-not-string");
  }
  if (id === "") {
    return fail("id-empty");
  }

  if (op === "put") {
    const payload = fields.get("value");
    if (payload === undefined) {
      return fail("value-missing");
    }
    if (!isJsonObject(payload)) {
      return fail("value-not-object");
    }
    const nullPath = findNull(payload, []);
    if (nullPath !== undefined) {
      return fail("value-has-null", nullPath);
    }
    return { ok: true, action: { op: "put", id, value: payload } };
  }

  if (op === "patch") {
    const payload = fields.get("patch");
    if (payload === undefined) {
      return fail("patch-missing");
    }
    if (!isJsonObject(payload)) {
      return fail("patch-not-object");
    }
    const nullPath = findNullInArray(payload, [], false);
    if (nullPath !== undefined) {
      return fail("patch-null-in-array", nullPath);
    }
    return { ok: true, action: { op: "patch", id, patch: payload } };
  }

  return { ok: true, action: { op: "delete", id } };
};
