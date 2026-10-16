import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { open } from "./db.js";

/** Build the log as text so this test exercises replay, not the write path. */
const generateLog = (count: number): string => {
  const lines = ['{"nddb":1}'];
  for (let i = 0; i < count; i += 1) {
    const value = { n: i, name: `entity number ${i}`, tags: ["a", "b", "c"] };
    lines.push(JSON.stringify({ op: "put", id: `entity_${i}`, value }));
  }
  return `${lines.join("\n")}\n`;
};

describe("size envelope", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nddb-size-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([10_000, 50_000])("materializes a %i-action log", (count) => {
    const path = join(dir, `log-${count}.ndjson`);
    writeFileSync(path, generateLog(count));

    const db = open(path);
    try {
      expect(db.all()).toHaveLength(count);
      expect(db.get("entity_1234")).toMatchObject({
        id: "entity_1234",
        n: 1234,
        tags: ["a", "b", "c"],
      });
    } finally {
      db.close();
    }
  });
});
