import type { ActionErrorCode, ActionPath } from "./action.js";
import { FORMAT_VERSION, type LogDamage } from "./log.js";

/**
 * nddb's own failure codes.
 *
 * Node's I/O errors keep their four-letter `code` and pass through untouched,
 * so this union deliberately covers only nddb's namespace.
 */
export type ErrorCode =
  | ActionErrorCode
  | "NDDB_DAMAGED"
  | "NDDB_UNSUPPORTED_VERSION"
  | "NDDB_CLOSED"
  | "NDDB_DURABILITY_CONFLICT";

/** A plain `Error` a caller branches on by `code`; no classes, no `instanceof`. */
export type NdDbError = Error & {
  readonly code: ErrorCode;
  readonly path?: ActionPath;
  readonly damage?: LogDamage;
  readonly version?: number;
};

/** The one constructor for nddb's own errors; a caller branches on `code`. */
export const nddbError = (
  code: ErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): NdDbError => Object.assign(new Error(message), { code, ...extra }) as NdDbError;

/** Which payload a code rejects, for a message a caller can read without the table. */
const payloadSubject = (code: ActionErrorCode): string => {
  if (code.startsWith("value-")) {
    return "put payload";
  }
  if (code.startsWith("patch-")) {
    return "patch payload";
  }
  return "action";
};

/** A grammar rejection; `path` points into the offending payload when known. */
export const actionError = (code: ActionErrorCode, path?: ActionPath): NdDbError =>
  nddbError(
    code,
    `invalid ${payloadSubject(code)}: ${code}${path === undefined ? "" : ` at ${JSON.stringify(path)}`}`,
    path === undefined ? undefined : { path },
  );

/**
 * A payload the log cannot carry faithfully: `JSON.stringify` would drop,
 * mangle, or refuse it (#16).
 */
export const notJsonError = (reason: string, path: ActionPath): NdDbError =>
  nddbError("not-json", `value is not JSON-representable: ${reason} at ${JSON.stringify(path)}`, {
    path,
  });

/** Wrap a `LogDamage` record from reading the log. */
export const damagedError = (damage: LogDamage): NdDbError =>
  nddbError("NDDB_DAMAGED", `damaged log at line ${damage.line}: ${damage.kind}`, { damage });

/** Refuse a log written by a newer format than this build understands. */
export const unsupportedVersionError = (version: number): NdDbError =>
  nddbError(
    "NDDB_UNSUPPORTED_VERSION",
    `unsupported log version ${version}; this build reads up to ${FORMAT_VERSION}`,
    { version },
  );

/** Use of a handle after `close()`. */
export const closedError = (): NdDbError => nddbError("NDDB_CLOSED", "handle is closed");

/** A second `open` whose durability contradicts the live handle's. */
export const durabilityConflictError = (path: string, requested: string, live: string): NdDbError =>
  nddbError(
    "NDDB_DURABILITY_CONFLICT",
    `${path} is already open with durability "${live}", cannot reopen with "${requested}"`,
  );
