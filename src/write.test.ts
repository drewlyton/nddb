import {
  appendFileSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action } from "./action.js";
import { createWriter } from "./write.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    writeSync: vi.fn(actual.writeSync),
  };
});

const fsyncSpy = vi.mocked(fsyncSync);
const writeSpy = vi.mocked(writeSync);

describe("createWriter", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nddb-write-"));
    path = join(dir, "db.ndjson");
    fsyncSpy.mockClear();
    writeSpy.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("bytes and order", () => {
    it("appends one newline-terminated put line with a fixed envelope order", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path);
      const action: Action = { id: "todo_1", value: { z: 1, a: 2 }, op: "put" };

      writer.append(action);

      expect(readFileSync(path, "utf8")).toBe(
        '{"nddb":1}\n{"op":"put","id":"todo_1","value":{"z":1,"a":2}}\n',
      );
      expect(existsSync(path)).toBe(true);
    });

    it("appends one patch line with patch after id", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path);
      const action: Action = {
        patch: { done: true, z: 1 },
        id: "todo_1",
        op: "patch",
      };

      writer.append(action);

      expect(readFileSync(path, "utf8")).toBe(
        '{"nddb":1}\n{"op":"patch","id":"todo_1","patch":{"done":true,"z":1}}\n',
      );
    });

    it("appends one delete line with only op and id", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path);
      const action: Action = { id: "todo_1", op: "delete" };

      writer.append(action);

      expect(readFileSync(path, "utf8")).toBe('{"nddb":1}\n{"op":"delete","id":"todo_1"}\n');
    });
  });

  describe("header on create", () => {
    it("constructs without creating the file, then writes the header and the action", () => {
      const writer = createWriter(path);

      expect(existsSync(path)).toBe(false);

      writer.append({ op: "delete", id: "todo_1" });

      expect(readFileSync(path, "utf8")).toBe('{"nddb":1}\n{"op":"delete","id":"todo_1"}\n');
    });

    it("adds no header to a pre-existing empty file", () => {
      writeFileSync(path, "", "utf8");
      const writer = createWriter(path);

      writer.append({ op: "delete", id: "todo_1" });

      expect(readFileSync(path, "utf8")).toBe('{"op":"delete","id":"todo_1"}\n');
    });

    it("adds no header to a pre-existing file with a valid line", () => {
      const existing = '{"nddb":1}\n{"op":"put","id":"a","value":{}}\n';
      writeFileSync(path, existing, "utf8");
      const writer = createWriter(path);

      writer.append({ op: "delete", id: "b" });

      expect(readFileSync(path, "utf8")).toBe(`${existing}{"op":"delete","id":"b"}\n`);
    });

    it("still writes the header when the parent directory fsync is refused", () => {
      const writer = createWriter(path);
      fsyncSpy.mockImplementationOnce(() => {
        throw new Error("directory fsync refused");
      });

      expect(() => writer.append({ op: "delete", id: "todo_1" })).not.toThrow();
      expect(readFileSync(path, "utf8")).toBe('{"nddb":1}\n{"op":"delete","id":"todo_1"}\n');
    });
  });

  describe("truncate before append", () => {
    it("drops a torn tail and appends after the last newline", () => {
      const valid = '{"op":"put","id":"a","value":{"n":1}}\n';
      writeFileSync(path, `${valid}{"op":"put","id":"b"`, "utf8");
      const writer = createWriter(path);

      writer.append({ op: "delete", id: "b" });

      expect(readFileSync(path, "utf8")).toBe(`${valid}{"op":"delete","id":"b"}\n`);
    });

    it("truncates a torn tail with no newline to an empty file before appending", () => {
      writeFileSync(path, '{"op":"put","id":"b"', "utf8");
      const writer = createWriter(path);

      writer.append({ op: "delete", id: "b" });

      expect(readFileSync(path, "utf8")).toBe('{"op":"delete","id":"b"}\n');
    });
  });

  describe("pre-flight guard", () => {
    it("refuses a repair when the file changed, leaving every byte untouched", () => {
      const torn = '{"op":"put","id":"a","value":{}}\n{"op":"put","id":"b"';
      writeFileSync(path, torn, "utf8");
      const writer = createWriter(path);
      appendFileSync(path, ',"value":{"x":1}', "utf8");
      const before = readFileSync(path);

      expect(() => writer.append({ op: "delete", id: "c" })).toThrow(Error);
      expect(readFileSync(path).equals(before)).toBe(true);
    });

    it("appends normally when an external append completed the record with a newline", () => {
      const torn = '{"op":"put","id":"a","value":{}}\n{"op":"put","id":"b"';
      writeFileSync(path, torn, "utf8");
      const writer = createWriter(path);
      appendFileSync(path, ',"value":{"x":1}}\n', "utf8");

      writer.append({ op: "delete", id: "c" });

      expect(readFileSync(path, "utf8")).toBe(
        `${torn},"value":{"x":1}}\n{"op":"delete","id":"c"}\n`,
      );
    });
  });

  describe("durability", () => {
    it("never fsyncs for a buffered append", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path, { durability: "buffered" });
      fsyncSpy.mockClear();

      writer.append({ op: "delete", id: "todo_1" });

      expect(fsyncSpy).not.toHaveBeenCalled();
    });

    it("fsyncs once per strict append", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path, { durability: "strict" });
      fsyncSpy.mockClear();

      writer.append({ op: "delete", id: "todo_1" });
      expect(fsyncSpy).toHaveBeenCalledTimes(1);

      writer.append({ op: "delete", id: "todo_2" });
      expect(fsyncSpy).toHaveBeenCalledTimes(2);
    });

    it("fsyncs on flush after a buffered append", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path);
      fsyncSpy.mockClear();

      writer.append({ op: "delete", id: "todo_1" });
      expect(fsyncSpy).not.toHaveBeenCalled();

      writer.flush();
      expect(fsyncSpy).toHaveBeenCalledTimes(1);
    });

    it("fsyncs on close after a buffered append", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path);
      fsyncSpy.mockClear();

      writer.append({ op: "delete", id: "todo_1" });
      writer.close();

      expect(fsyncSpy).toHaveBeenCalledTimes(1);
    });

    it("makes a strict flush a no-op, since every append already fsynced", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path, { durability: "strict" });
      writer.append({ op: "delete", id: "todo_1" });
      fsyncSpy.mockClear();

      writer.flush();

      expect(fsyncSpy).not.toHaveBeenCalled();
    });

    it("surfaces a short write instead of silently tearing the record", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path);
      writeSpy.mockImplementationOnce(() => 0);

      expect(() => writer.append({ op: "delete", id: "todo_1" })).toThrow(/short write/);
    });

    it("surfaces a failed fsync instead of swallowing it", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path, { durability: "strict" });
      fsyncSpy.mockImplementationOnce(() => {
        throw new Error("fsync failed");
      });

      expect(() => writer.append({ op: "delete", id: "todo_1" })).toThrow("fsync failed");
    });
  });

  describe("lifecycle", () => {
    it("treats a second close as a no-op and rejects use after close", () => {
      writeFileSync(path, '{"nddb":1}\n', "utf8");
      const writer = createWriter(path);
      writer.append({ op: "delete", id: "todo_1" });

      writer.close();
      writer.close();

      expect(() => writer.append({ op: "delete", id: "todo_2" })).toThrow(Error);
      expect(() => writer.flush()).toThrow(Error);
    });

    it("makes flush before any append a no-op that creates nothing", () => {
      const writer = createWriter(path);
      fsyncSpy.mockClear();

      writer.flush();

      expect(fsyncSpy).not.toHaveBeenCalled();
      expect(existsSync(path)).toBe(false);
    });
  });
});
