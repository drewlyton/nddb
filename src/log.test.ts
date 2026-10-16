import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActionErrorCode, ActionPath } from "./action.js";
import { parseLog, readLog, type LogRead } from "./log.js";

const putLine = (id: string, value: Record<string, unknown>): string =>
  JSON.stringify({ op: "put", id, value });

const expectInvalidJson = (result: LogRead, line: number): void => {
  expect(result.status).toBe("damaged");
  if (result.status !== "damaged" || result.damage.kind !== "invalid-json") {
    throw new Error("expected invalid-json damage");
  }
  expect(result.damage.line).toBe(line);
  expect(result.damage.cause).toBeTypeOf("string");
  expect(result.damage.cause.length).toBeGreaterThan(0);
};

const expectInvalidAction = (
  result: LogRead,
  expected: { line: number; code: ActionErrorCode; path?: ActionPath },
): void => {
  expect(result.status).toBe("damaged");
  if (result.status !== "damaged" || result.damage.kind !== "invalid-action") {
    throw new Error("expected invalid-action damage");
  }
  expect(result.damage.line).toBe(expected.line);
  expect(result.damage.code).toBe(expected.code);
  expect(result.damage.path).toEqual(expected.path);
};

const expectInvalidHeader = (result: LogRead, line: number): void => {
  expect(result.status).toBe("damaged");
  if (result.status !== "damaged" || result.damage.kind !== "invalid-header") {
    throw new Error("expected invalid-header damage");
  }
  expect(result.damage.line).toBe(line);
  expect(result.damage.cause).toBeTypeOf("string");
};

describe("parseLog", () => {
  describe("ok", () => {
    it("reads empty text as an empty version 1 log", () => {
      expect(parseLog("")).toEqual({ status: "ok", version: 1, actions: [] });
    });

    it("reads whitespace-only text as an empty version 1 log", () => {
      expect(parseLog("\n\n   \n\t\n")).toEqual({ status: "ok", version: 1, actions: [] });
    });

    it("reads a single headerless action", () => {
      const action = { op: "put", id: "a", value: { title: "first" } };

      expect(parseLog(`${JSON.stringify(action)}\n`)).toEqual({
        status: "ok",
        version: 1,
        actions: [action],
      });
    });

    it("reads a header followed by actions", () => {
      const action = { op: "delete", id: "a" };

      expect(parseLog(`{"nddb":1}\n${JSON.stringify(action)}\n`)).toEqual({
        status: "ok",
        version: 1,
        actions: [action],
      });
    });

    it("reads a header alone", () => {
      expect(parseLog(`{"nddb":1}\n`)).toEqual({ status: "ok", version: 1, actions: [] });
    });

    it("reads multiple headerless actions", () => {
      const actions = [
        { op: "put", id: "a", value: { title: "first" } },
        { op: "patch", id: "a", patch: { done: true } },
        { op: "delete", id: "a" },
      ];

      expect(parseLog(`${actions.map((action) => JSON.stringify(action)).join("\n")}\n`)).toEqual({
        status: "ok",
        version: 1,
        actions,
      });
    });

    it("ignores extra header fields", () => {
      expect(parseLog(`{"nddb":1,"note":"x"}\n`)).toEqual({
        status: "ok",
        version: 1,
        actions: [],
      });
    });

    it("treats an action carrying an nddb field as an action, not a header", () => {
      const action = { op: "put", id: "a", value: {}, nddb: 9 };

      expect(parseLog(`${JSON.stringify(action)}\n`)).toEqual({
        status: "ok",
        version: 1,
        actions: [{ op: "put", id: "a", value: {} }],
      });
    });
  });

  describe("read tolerance", () => {
    it("strips a leading BOM", () => {
      const action = { op: "delete", id: "a" };

      expect(parseLog(`\uFEFF${JSON.stringify(action)}\n`)).toEqual({
        status: "ok",
        version: 1,
        actions: [action],
      });
    });

    it("strips a leading BOM before header detection", () => {
      expect(parseLog('\uFEFF{"nddb":1}\n')).toEqual({
        status: "ok",
        version: 1,
        actions: [],
      });
    });

    it("accepts CRLF line endings", () => {
      const first = { op: "put", id: "a", value: { title: "first" } };
      const second = { op: "delete", id: "a" };

      expect(parseLog(`${JSON.stringify(first)}\r\n${JSON.stringify(second)}\r\n`)).toEqual({
        status: "ok",
        version: 1,
        actions: [first, second],
      });
    });

    it("accepts CRLF on the header line", () => {
      const action = { op: "delete", id: "a" };

      expect(parseLog(`{"nddb":1}\r\n${JSON.stringify(action)}\r\n`)).toEqual({
        status: "ok",
        version: 1,
        actions: [action],
      });
    });
  });

  describe("torn tail", () => {
    it("drops a final valid action with no trailing newline", () => {
      const complete = { op: "put", id: "a", value: { title: "first" } };
      const torn = { op: "put", id: "b", value: { title: "second" } };

      expect(parseLog(`${JSON.stringify(complete)}\n${JSON.stringify(torn)}`)).toEqual({
        status: "ok",
        version: 1,
        actions: [complete],
      });
    });

    it("drops a final malformed line with no trailing newline", () => {
      const complete = { op: "delete", id: "a" };

      expect(parseLog(`${JSON.stringify(complete)}\n{"op":"nope`)).toEqual({
        status: "ok",
        version: 1,
        actions: [complete],
      });
    });

    it("drops a complete-looking empty object with no trailing newline", () => {
      expect(parseLog("{}")).toEqual({ status: "ok", version: 1, actions: [] });
    });

    it("drops a header-only file with no trailing newline", () => {
      expect(parseLog('{"nddb":1}')).toEqual({ status: "ok", version: 1, actions: [] });
    });

    it("drops a torn newer header as a benign tail rather than refusing it", () => {
      // An unfinished record never existed, so a torn header is silent. It is
      // the only place loud version refusal yields to the torn-tail rule.
      expect(parseLog('{"nddb":2}')).toEqual({ status: "ok", version: 1, actions: [] });
    });

    it("drops a whitespace-only torn tail before blank filtering", () => {
      const action = { op: "put", id: "a", value: {} };

      expect(parseLog(`${JSON.stringify(action)}\n   `)).toEqual({
        status: "ok",
        version: 1,
        actions: [action],
      });
    });

    it("drops a carriage-return-only trailing fragment", () => {
      const action = { op: "put", id: "a", value: {} };

      expect(parseLog(`${JSON.stringify(action)}\r\n\r`)).toEqual({
        status: "ok",
        version: 1,
        actions: [action],
      });
    });
  });

  describe("blank lines", () => {
    it("skips blank and whitespace-only lines anywhere", () => {
      const first = { op: "put", id: "a", value: { title: "first" } };
      const second = { op: "delete", id: "a" };
      const text = `\n${JSON.stringify(first)}\n   \n\t\n${JSON.stringify(second)}\n\n`;

      expect(parseLog(text)).toEqual({ status: "ok", version: 1, actions: [first, second] });
    });

    it("treats a header after leading blanks as line 1", () => {
      const action = { op: "delete", id: "a" };
      const text = `\n\n{"nddb":1}\n${JSON.stringify(action)}\n`;

      expect(parseLog(text)).toEqual({ status: "ok", version: 1, actions: [action] });
    });
  });

  describe("damage", () => {
    it("reports invalid-json for an unparseable complete line", () => {
      const prefix = { op: "put", id: "a", value: {} };
      const result = parseLog(`${JSON.stringify(prefix)}\nnot json\n`);

      expectInvalidJson(result, 2);
      expect(result.status === "damaged" && result.actions).toEqual([prefix]);
    });

    it("reports invalid-json for a truncated header", () => {
      const result = parseLog('{"nddb":1\n');

      expectInvalidJson(result, 1);
      expect(result.status === "damaged" && result.actions).toEqual([]);
    });

    it.each([
      { name: "a string", marker: '"1"' },
      { name: "zero", marker: "0" },
      { name: "a fraction", marker: "1.5" },
      { name: "null", marker: "null" },
    ])("reports invalid-header for nddb $name", ({ marker }) => {
      const result = parseLog(`{"nddb":${marker}}\n`);

      expectInvalidHeader(result, 1);
      expect(result.status === "damaged" && result.actions).toEqual([]);
    });

    it("reports invalid-action op-missing for an empty object on line 1", () => {
      const result = parseLog("{}\n");

      expectInvalidAction(result, { line: 1, code: "op-missing" });
      expect(result.status === "damaged" && result.version).toBe(1);
    });

    it("reports invalid-action op-missing for a header-shaped object after line 1", () => {
      const prefix = { op: "delete", id: "a" };
      const result = parseLog(`${JSON.stringify(prefix)}\n{"nddb":1}\n`);

      expectInvalidAction(result, { line: 2, code: "op-missing" });
      expect(result.status === "damaged" && result.actions).toEqual([prefix]);
    });

    it("reports invalid-action op-unknown for an unknown op", () => {
      const result = parseLog('{"op":"nope","id":"a"}\n');

      expectInvalidAction(result, { line: 1, code: "op-unknown" });
    });

    it("reports invalid-action value-has-null with the path for a null-bearing put", () => {
      const result = parseLog('{"op":"put","id":"a","value":{"x":null}}\n');

      expectInvalidAction(result, { line: 1, code: "value-has-null", path: ["x"] });
    });
  });

  describe("line numbers", () => {
    it("reports the original file line across blank lines and a consumed header", () => {
      const first = { op: "put", id: "a", value: {} };
      const text = `{"nddb":1}\n\n${JSON.stringify(first)}\n   \n{"op":"nope","id":"b"}\n`;
      const result = parseLog(text);

      expectInvalidAction(result, { line: 5, code: "op-unknown" });
      expect(result.status === "damaged" && result.actions).toEqual([first]);
      expect(result.status === "damaged" && result.version).toBe(1);
    });
  });

  describe("stop at first damage", () => {
    it("returns the valid prefix and excludes later valid actions", () => {
      const first = { op: "put", id: "a", value: {} };
      const later = { op: "put", id: "b", value: {} };
      const text = `${JSON.stringify(first)}\n{}\n${JSON.stringify(later)}\n`;
      const result = parseLog(text);

      expectInvalidAction(result, { line: 2, code: "op-missing" });
      expect(result.status === "damaged" && result.actions).toEqual([first]);
    });
  });

  describe("version", () => {
    it("returns unsupported-version with the file version and no actions", () => {
      expect(parseLog('{"nddb":2}\n')).toEqual({ status: "unsupported-version", version: 2 });
    });

    it("returns unsupported-version even when valid actions follow", () => {
      const result = parseLog(`{"nddb":2}\n${putLine("a", {})}\n`);

      expect(result).toEqual({ status: "unsupported-version", version: 2 });
      expect(result.status === "damaged" || result.status === "ok").toBe(false);
    });

    it("reads a version 1 header as ok", () => {
      expect(parseLog('{"nddb":1}\n')).toEqual({ status: "ok", version: 1, actions: [] });
    });

    it("defaults a headerless file to version 1", () => {
      const result = parseLog(`${putLine("a", {})}\n`);

      expect(result.status).toBe("ok");
      expect(result.status === "ok" && result.version).toBe(1);
    });
  });
});

describe("readLog", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nddb-log-"));
    path = join(dir, "db.ndjson");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a missing file as an empty version 1 log", () => {
    expect(readLog(join(dir, "missing.ndjson"))).toEqual({
      status: "ok",
      version: 1,
      actions: [],
    });
  });

  it("reads a real file with a BOM, CRLF, and a torn tail", () => {
    const action = { op: "put", id: "a", value: { title: "first" } };
    writeFileSync(
      path,
      `\uFEFF{"nddb":1}\r\n${JSON.stringify(action)}\r\n{"op":"delete","id":"a"}`,
      "utf8",
    );

    expect(readLog(path)).toEqual({ status: "ok", version: 1, actions: [action] });
  });
});
