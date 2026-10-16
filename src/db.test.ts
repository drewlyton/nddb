import {
  appendFileSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { open } from "./db.js";
import type { NdDbError } from "./errors.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});

const fsyncSpy = vi.mocked(fsyncSync);

const putLine = (id: string, value: Record<string, unknown>): string =>
  JSON.stringify({ op: "put", id, value });

const patchLine = (id: string, patch: Record<string, unknown>): string =>
  JSON.stringify({ op: "patch", id, patch });

const deleteLine = (id: string): string => JSON.stringify({ op: "delete", id });

/** Run `call` and return the error it threw; fail loudly when it does not throw. */
const capture = (call: () => unknown): NdDbError => {
  try {
    call();
  } catch (error) {
    return error as NdDbError;
  }
  throw new Error("expected the call to throw");
};

describe("open", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nddb-db-"));
    path = join(dir, "db.ndjson");
    fsyncSpy.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("reading", () => {
    it("reads a missing log as an empty database", () => {
      expect(open(path).all()).toEqual([]);
    });

    it("does not create or touch the file on open", () => {
      open(path);

      expect(existsSync(path)).toBe(false);
    });

    it("materializes put, patch, and delete in order", () => {
      writeFileSync(
        path,
        [
          '{"nddb":1}',
          putLine("a", { title: "first", tags: ["x"] }),
          putLine("b", { title: "second" }),
          patchLine("a", { title: "renamed", done: true }),
          deleteLine("b"),
        ].join("\n") + "\n",
        "utf8",
      );

      const db = open(path);

      expect(db.get("a")).toEqual({ id: "a", title: "renamed", tags: ["x"], done: true });
      expect(db.get("b")).toBeUndefined();
      expect(db.all()).toEqual([{ id: "a", title: "renamed", tags: ["x"], done: true }]);
    });

    it("materializes a patch onto an unknown id as a create", () => {
      writeFileSync(path, `${patchLine("a", { title: "from patch" })}\n`, "utf8");

      expect(open(path).get("a")).toEqual({ id: "a", title: "from patch" });
    });

    it("returns a plain object handle with no prototype machinery", () => {
      const db = open(path);

      expect(Object.getPrototypeOf(db)).toBe(Object.prototype);
      expect(Object.hasOwn(open, "prototype")).toBe(false);
    });
  });

  describe("writing", () => {
    it("put is create-or-replace", () => {
      const db = open<{ title: string; done?: boolean }>(path);
      db.put({ id: "a", title: "first", done: false });
      db.put({ id: "a", title: "second" });

      expect(db.get("a")).toEqual({ id: "a", title: "second" });
    });

    it("patch merges recursively and leaves other fields alone", () => {
      const db = open<{ profile: { name: string; city: string }; done: boolean }>(path);
      db.put({ id: "a", profile: { name: "ada", city: "london" }, done: false });
      db.patch("a", { profile: { city: "paris" } });

      expect(db.get("a")).toEqual({
        id: "a",
        profile: { name: "ada", city: "paris" },
        done: false,
      });
    });

    it("delete is idempotent and hard", () => {
      const db = open<{ n: number }>(path);
      db.put({ id: "a", n: 1 });

      db.delete("a");
      db.delete("a");

      expect(db.get("a")).toBeUndefined();
      expect(db.all()).toEqual([]);
    });

    it("every write and flush returns undefined rather than a Promise", () => {
      const db = open<{ n: number }>(path);

      expect(db.put({ id: "a", n: 1 })).toBeUndefined();
      expect(db.patch("a", { n: 2 })).toBeUndefined();
      expect(db.delete("a")).toBeUndefined();
      expect(db.flush()).toBeUndefined();
    });

    it("appends one line per action and replays them on reopen", () => {
      const db = open<{ title: string }>(path);
      db.put({ id: "a", title: "first" });
      db.patch("a", { title: "second" });

      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(3);

      db.close();
      expect(open<{ title: string }>(path).get("a")).toEqual({ id: "a", title: "second" });
    });
  });

  describe("copy-on-read and copy-in", () => {
    it("mutating a returned entity or array does not change the view", () => {
      const db = open<{ title: string; tags: string[] }>(path);
      db.put({ id: "a", title: "first", tags: ["x"] });

      const got = db.get("a");
      got!.title = "mutated";
      got!.tags.push("y");

      const list = db.all();
      list[0]!.title = "mutated again";
      list[0]!.tags.push("z");

      expect(db.get("a")).toEqual({ id: "a", title: "first", tags: ["x"] });
      expect(db.all()).toEqual([{ id: "a", title: "first", tags: ["x"] }]);
    });

    it("mutating the caller's object after put changes neither view nor file", () => {
      const db = open<{ tags: string[]; nested: { n: number } }>(path);
      const entity = { id: "a", tags: ["x"], nested: { n: 1 } };

      db.put(entity);
      entity.tags.push("y");
      entity.nested.n = 2;

      expect(db.get("a")).toEqual({ id: "a", tags: ["x"], nested: { n: 1 } });

      db.close();
      expect(open<{ tags: string[]; nested: { n: number } }>(path).get("a")).toEqual({
        id: "a",
        tags: ["x"],
        nested: { n: 1 },
      });
    });
  });

  describe("cache and realpath", () => {
    it("returns the same handle for the same path", () => {
      const db = open(path);

      expect(open(path)).toBe(db);
    });

    it("exposes the resolved absolute path as a read-only key", () => {
      const indirect = join(dir, "sub", "..", "db.ndjson");

      expect(open(indirect).path).toBe(resolve(path));
    });

    it("uses the realpath as the key when the file exists", () => {
      writeFileSync(path, `${putLine("a", {})}\n`, "utf8");

      expect(open(path).path).toBe(realpathSync(path));
    });

    it("reuses the handle for matching or omitted durability", () => {
      const db = open(path);

      expect(open(path)).toBe(db);
      expect(open(path, { durability: "buffered" })).toBe(db);
    });

    it("throws on a conflicting durability and keeps the live handle", () => {
      const db = open(path);

      const error = capture(() => open(path, { durability: "strict" }));

      expect(error.code).toBe("NDDB_DURABILITY_CONFLICT");
      expect(open(path)).toBe(db);
    });

    it("opens a symlink and its target to the same handle", () => {
      if (process.platform === "win32") {
        return;
      }
      const target = join(dir, "target.ndjson");
      const link = join(dir, "link.ndjson");
      writeFileSync(target, `${putLine("a", {})}\n`, "utf8");
      symlinkSync(target, link);

      expect(open(link)).toBe(open(target));
    });
  });

  describe("close and use-after-close", () => {
    it("close is idempotent and optional", () => {
      const db = open<{ n: number }>(path);
      db.put({ id: "a", n: 1 });

      expect(() => db.close()).not.toThrow();
      expect(() => db.close()).not.toThrow();
    });

    it("flushes on every close, and releases only the last reference", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const first = open<{ n: number }>(path);
      const second = open<{ n: number }>(path);
      first.put({ id: "a", n: 1 });
      fsyncSpy.mockClear();

      first.close();

      expect(fsyncSpy).toHaveBeenCalledTimes(1);
      expect(second.get("a")).toEqual({ id: "a", n: 1 });

      second.close();
      expect(capture(() => second.get("a")).code).toBe("NDDB_CLOSED");
      expect(open(path)).not.toBe(first);
    });

    it("throws NDDB_CLOSED for reads, writes, and flush after close", () => {
      const db = open<{ n: number }>(path);
      db.put({ id: "a", n: 1 });
      db.close();

      expect(capture(() => db.get("a")).code).toBe("NDDB_CLOSED");
      expect(capture(() => db.all()).code).toBe("NDDB_CLOSED");
      expect(capture(() => db.put({ id: "b", n: 2 })).code).toBe("NDDB_CLOSED");
      expect(capture(() => db.patch("a", { n: 3 })).code).toBe("NDDB_CLOSED");
      expect(capture(() => db.delete("a")).code).toBe("NDDB_CLOSED");
      expect(capture(() => db.flush()).code).toBe("NDDB_CLOSED");
    });

    it("re-reading after a full close picks up external writes", () => {
      const db = open<{ n: number }>(path);
      db.put({ id: "a", n: 1 });
      db.close();
      appendFileSync(path, `${putLine("b", { n: 2 })}\n`, "utf8");

      const reopened = open<{ n: number }>(path);

      expect(reopened).not.toBe(db);
      expect(reopened.all()).toEqual([
        { id: "a", n: 1 },
        { id: "b", n: 2 },
      ]);
    });
  });

  describe("flush is synchronous", () => {
    it("fsyncs once on a buffered flush, never on a buffered append", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const db = open<{ n: number }>(path);
      fsyncSpy.mockClear();

      db.put({ id: "a", n: 1 });
      expect(fsyncSpy).not.toHaveBeenCalled();

      db.flush();
      expect(fsyncSpy).toHaveBeenCalledTimes(1);
    });

    it("fsyncs once per append under strict", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const db = open<{ n: number }>(path, { durability: "strict" });
      fsyncSpy.mockClear();

      db.put({ id: "a", n: 1 });
      expect(fsyncSpy).toHaveBeenCalledTimes(1);

      db.put({ id: "b", n: 2 });
      expect(fsyncSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("damage", () => {
    it("throws NDDB_DAMAGED with the damage record by default", () => {
      writeFileSync(path, `${putLine("a", { n: 1 })}\nnot json\n${putLine("b", { n: 2 })}\n`);

      const error = capture(() => open(path));

      expect(error.code).toBe("NDDB_DAMAGED");
      expect(error.damage).toEqual({
        kind: "invalid-json",
        line: 2,
        cause: expect.any(String),
      });
    });

    it("salvage reads the valid prefix but refuses every write", () => {
      writeFileSync(path, `${putLine("a", { n: 1 })}\nnot json\n${putLine("b", { n: 2 })}\n`);

      const db = open<{ n: number }>(path, { onDamage: "salvage" });

      expect(db.get("a")).toEqual({ id: "a", n: 1 });
      expect(capture(() => db.put({ id: "c", n: 3 })).code).toBe("NDDB_DAMAGED");
      expect(capture(() => db.patch("a", { n: 9 })).code).toBe("NDDB_DAMAGED");
      expect(capture(() => db.delete("a")).code).toBe("NDDB_DAMAGED");
    });

    it("refuses a newer header even when salvage is requested", () => {
      writeFileSync(path, '{"nddb":2}\n', "utf8");

      expect(capture(() => open(path)).code).toBe("NDDB_UNSUPPORTED_VERSION");
      const error = capture(() => open(path, { onDamage: "salvage" }));
      expect(error.code).toBe("NDDB_UNSUPPORTED_VERSION");
      expect(error.version).toBe(2);
    });
  });

  describe("write validation", () => {
    it("rejects a non-object entity", () => {
      const db = open(path);

      expect(capture(() => db.put(null as never)).code).toBe("not-an-object");
      expect(capture(() => db.put([1, 2] as never)).code).toBe("not-an-object");
    });

    it("rejects non-JSON values with a path before touching the writer", () => {
      const db = open(path);

      const cases: [string, Record<string, unknown>][] = [
        ["non-finite number", { n: Number.NaN }],
        ["non-finite number", { n: Number.POSITIVE_INFINITY }],
        ["undefined", { n: undefined }],
        ["function", { n: () => 1 }],
        ["bigint", { n: 1n }],
      ];

      for (const [reason, payload] of cases) {
        const error = capture(() => db.put({ id: "a", ...payload }));
        expect(error.code).toBe("not-json");
        expect(error.message).toContain(reason);
        expect(error.path).toEqual(["n"]);
      }

      expect(existsSync(path)).toBe(false);
    });

    it("rejects a cycle with a path", () => {
      const db = open(path);
      const cyclic: Record<string, unknown> = {};

      cyclic["self"] = cyclic;

      const error = capture(() => db.put({ id: "a", ...cyclic }));

      expect(error.code).toBe("not-json");
      expect(error.message).toContain("cycle");
      expect(error.path?.length).toBeGreaterThan(0);
    });

    it("rejects an empty or non-string id", () => {
      const db = open(path);

      expect(capture(() => db.put({ id: "" })).code).toBe("id-empty");
      expect(capture(() => db.put({ id: 1 } as never)).code).toBe("id-not-string");
      expect(capture(() => db.put({} as never)).code).toBe("id-missing");
      expect(capture(() => db.patch("", { n: 1 })).code).toBe("id-empty");
      expect(capture(() => db.delete("")).code).toBe("id-empty");
    });

    it("rejects a null in a put payload at its path", () => {
      const db = open(path);

      const error = capture(() => db.put({ id: "a", author: { name: null } }));

      expect(error.code).toBe("value-has-null");
      expect(error.path).toEqual(["author", "name"]);
    });

    it("rejects a null inside an array in a patch", () => {
      const db = open(path);

      expect(capture(() => db.patch("a", { tags: ["x", null] } as never)).code).toBe(
        "patch-null-in-array",
      );
    });
  });

  describe("append first, fold only on success", () => {
    it("refuses the append when the file changed behind the handle and keeps the view", () => {
      const valid = `${putLine("a", { n: 1 })}\n`;
      writeFileSync(path, `${valid}{"op":"put","id":"b"`, "utf8");
      const db = open<{ n: number }>(path);
      expect(db.all()).toEqual([{ id: "a", n: 1 }]);

      appendFileSync(path, ',"value":{"n":2}}', "utf8");

      expect(() => db.put({ id: "c", n: 3 })).toThrow(/changed since it was read/);
      expect(db.all()).toEqual([{ id: "a", n: 1 }]);
    });
  });

  describe("torn tail", () => {
    it("drops an incomplete trailing record and repairs it on the next write", () => {
      const valid = `${putLine("a", { n: 1 })}\n`;
      writeFileSync(path, `${valid}{"op":"put","id":"b"`, "utf8");

      const db = open<{ n: number }>(path);
      expect(db.all()).toEqual([{ id: "a", n: 1 }]);

      db.put({ id: "c", n: 3 });
      db.close();

      expect(readFileSync(path, "utf8")).toBe(`${valid}${putLine("c", { n: 3 })}\n`);
      expect(open<{ n: number }>(path).all()).toEqual([
        { id: "a", n: 1 },
        { id: "c", n: 3 },
      ]);
      expect(statSync(path).size).toBeGreaterThan(0);
    });
  });
});
