import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { open } from "./db.js";

describe("nddb", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nddb-"));
    path = join(dir, "db.ndjson");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a missing log as an empty database", () => {
    expect(open(path).all()).toEqual([]);
  });

  it("materializes puts from the log on open", () => {
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "put", id: "a", value: { title: "first" } }),
        JSON.stringify({ type: "put", id: "b", value: { title: "second" } }),
      ].join("\n") + "\n",
    );

    expect(open(path).all()).toEqual([
      { id: "a", title: "first" },
      { id: "b", title: "second" },
    ]);
  });

  it("patches an existing entity without dropping other fields", () => {
    const db = open(path);
    db.put({ id: "a", title: "first", done: false });
    db.patch("a", { done: true });

    expect(db.get("a")).toEqual({ id: "a", title: "first", done: true });
  });

  it("creates an entity when patching an unknown id", () => {
    const db = open(path);
    db.patch("a", { title: "from patch" });

    expect(db.get("a")).toEqual({ id: "a", title: "from patch" });
  });

  it("appends one action per line and replays them in order", () => {
    const db = open(path);
    db.put({ id: "a", title: "first" });
    db.patch("a", { title: "second" });
    db.put({ id: "a", title: "third" });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(open(path).get("a")).toEqual({ id: "a", title: "third" });
  });
});
