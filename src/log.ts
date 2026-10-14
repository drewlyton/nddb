import { appendFileSync, existsSync, readFileSync } from "node:fs";

import type { Action } from "./action.js";

/**
 * Read every action from an NDJSON file.
 *
 * A missing file reads as an empty log. Blank lines are ignored so a trailing
 * newline is not an error.
 */
export const readActions = (path: string): Action[] => {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Action);
};

/** Append one action to the NDJSON file as a single line. */
export const appendAction = (path: string, action: Action): void => {
  appendFileSync(path, `${JSON.stringify(action)}\n`, "utf8");
};
