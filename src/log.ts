import { existsSync, readFileSync } from "node:fs";

import { classifyAction, type Action, type ActionErrorCode, type ActionPath } from "./action.js";
import { isJsonObject } from "./json.js";

/** The log format version this build writes and understands. */
export const FORMAT_VERSION = 1;

/** Why a complete line could not be replayed. */
export type LogDamage =
  | { readonly kind: "invalid-json"; readonly line: number; readonly cause: string }
  | { readonly kind: "invalid-header"; readonly line: number; readonly cause: string }
  | {
      readonly kind: "invalid-action";
      readonly line: number;
      readonly code: ActionErrorCode;
      readonly path?: ActionPath;
    };

/**
 * The outcome of reading a log.
 *
 * `damaged` still carries the valid prefix, because the caller decides whether
 * that prefix may be salvaged. A version newer than this build understands is
 * refused outright — refusal is not damage, and salvage must not bypass it.
 */
export type LogRead =
  | { readonly status: "ok"; readonly version: number; readonly actions: readonly Action[] }
  | {
      readonly status: "damaged";
      readonly version: number;
      readonly actions: readonly Action[];
      readonly damage: LogDamage;
    }
  | { readonly status: "unsupported-version"; readonly version: number };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The `nddb` marker of a header-shaped object, or `undefined` if invalid. */
const headerVersion = (header: Record<string, unknown>): number | undefined => {
  const marker = header["nddb"];
  if (typeof marker !== "number" || !Number.isInteger(marker) || marker < 1) {
    return undefined;
  }
  return marker;
};

/**
 * Parse log text without touching the filesystem.
 *
 * A torn tail and blank lines are benign and dropped. The first complete line
 * that cannot be applied is real damage: replay stops there, because applying
 * later actions would drop committed data and patch the wrong base (#9).
 */
export const parseLog = (text: string): LogRead => {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const elements = withoutBom.split("\n");

  // Bytes after the last newline are an unfinished record. No reader could
  // have honoured it, so dropping it loses nothing (#9).
  const tail = elements[elements.length - 1];
  if (tail !== undefined && tail !== "") {
    elements.pop();
  }

  const lines: { readonly line: number; readonly value: string }[] = [];
  elements.forEach((value, index) => {
    if (value.trim() !== "") {
      lines.push({ line: index + 1, value });
    }
  });

  let version = FORMAT_VERSION;
  let start = 0;

  const first = lines[0];
  if (first !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(first.value);
    } catch (error) {
      return {
        status: "damaged",
        version,
        actions: [],
        damage: { kind: "invalid-json", line: first.line, cause: errorMessage(error) },
      };
    }
    if (isJsonObject(parsed) && Object.hasOwn(parsed, "nddb") && !Object.hasOwn(parsed, "op")) {
      const header = headerVersion(parsed);
      if (header === undefined) {
        return {
          status: "damaged",
          version,
          actions: [],
          damage: {
            kind: "invalid-header",
            line: first.line,
            cause: `nddb must be an integer >= 1, got ${JSON.stringify(parsed["nddb"])}`,
          },
        };
      }
      if (header > FORMAT_VERSION) {
        // Refusal is not damage: salvaging bytes whose meaning we cannot
        // interpret is the silent misread the marker exists to prevent (#21).
        return { status: "unsupported-version", version: header };
      }
      version = header;
      start = 1;
    }
  }

  const actions: Action[] = [];
  for (const { line, value } of lines.slice(start)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      return {
        status: "damaged",
        version,
        actions,
        damage: { kind: "invalid-json", line, cause: errorMessage(error) },
      };
    }
    const check = classifyAction(parsed);
    if (!check.ok) {
      const damage: LogDamage =
        check.path === undefined
          ? { kind: "invalid-action", line, code: check.code }
          : { kind: "invalid-action", line, code: check.code, path: check.path };
      return { status: "damaged", version, actions, damage };
    }
    actions.push(check.action);
  }

  return { status: "ok", version, actions };
};

/** Read and validate the log at `path`. A missing file is an empty v1 log. */
export const readLog = (path: string): LogRead => {
  if (!existsSync(path)) {
    return { status: "ok", version: FORMAT_VERSION, actions: [] };
  }
  return parseLog(readFileSync(path, "utf8"));
};

/**
 * Serialise one action as a record with the format's fixed envelope order.
 *
 * The envelope is rebuilt from the fields so a caller cannot reorder `op` and
 * `id`; the payload object is stringified as given, verbatim (#7).
 */
export const serialiseAction = (action: Action): string => {
  switch (action.op) {
    case "put":
      return `${JSON.stringify({ op: action.op, id: action.id, value: action.value })}\n`;
    case "patch":
      return `${JSON.stringify({ op: action.op, id: action.id, patch: action.patch })}\n`;
    case "delete":
      return `${JSON.stringify({ op: action.op, id: action.id })}\n`;
  }
};
