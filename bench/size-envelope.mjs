#!/usr/bin/env node
/**
 * nddb size-envelope benchmark.
 *
 * Imports the built library, so run `pnpm bench` (which builds first). Every
 * number is indicative for one machine, not a guarantee.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { open } from "../dist/index.js";

const MB = 1024 * 1024;
const OPEN_SIZES = [10_000, 50_000, 100_000];
const BUFFERED_WRITES = 50_000;
const STRICT_WRITES = 10_000;

const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** A representative entity: a handful of scalar fields and a short array. */
const makeEntity = (i) => ({
  id: `entity_${i}`,
  n: i,
  name: `entity number ${i}`,
  tags: ["a", "b", "c"],
});

/** One header line plus one `put` per entity, built as text to skip the write path. */
const generateLog = (count) => {
  const lines = ['{"nddb":1}'];
  for (let i = 0; i < count; i += 1) {
    const { id, ...value } = makeEntity(i);
    lines.push(JSON.stringify({ op: "put", id, value }));
  }
  return `${lines.join("\n")}\n`;
};

/** Median `open(path)`, after confirming every entity materialized. */
const measureOpen = (path, count, runs) => {
  const check = open(path);
  const materialized = check.all().length;
  check.close();
  if (materialized !== count) {
    throw new Error(`expected ${count} entities, materialized ${materialized}`);
  }

  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    const db = open(path);
    samples.push(performance.now() - started);
    db.close();
  }
  return median(samples);
};

/** Time `count` puts, returning the elapsed milliseconds. */
const measureWrites = (path, count, options) => {
  const db = open(path, options);
  const started = performance.now();
  for (let i = 0; i < count; i += 1) {
    db.put(makeEntity(i));
  }
  const elapsed = performance.now() - started;
  return { db, elapsed };
};

const right = (value, width) => String(value).padStart(width);
const left = (value, width) => String(value).padEnd(width);
const fixed = (value, digits) => value.toFixed(digits);
const usPerOp = (ms, count) => (ms * 1000) / count;

const dir = mkdtempSync(join(tmpdir(), "nddb-bench-"));
try {
  console.log(`nddb size envelope — node ${process.version} ${process.platform}/${process.arch}`);
  // The temp dir is where every number is measured; on tmpfs `fsync` is a
  // no-op, so the strict rows only mean something on a real filesystem.
  console.log(`measuring in ${dir}`);
  console.log("");

  console.log("Eager open (read + fold the whole log, median of N runs)");
  console.log("");
  console.log(
    `  ${right("actions", 9)}   ${right("file MB", 9)}   ${right("open ms", 8)}   ${right("runs", 4)}`,
  );
  console.log(`  ${"-".repeat(9)}   ${"-".repeat(9)}   ${"-".repeat(8)}   ${"-".repeat(4)}`);
  for (const count of OPEN_SIZES) {
    const path = join(dir, `open-${count}.ndjson`);
    writeFileSync(path, generateLog(count));
    const megabytes = statSync(path).size / MB;
    const runs = count >= 100_000 ? 3 : 5;
    const ms = measureOpen(path, count, runs);
    console.log(
      `  ${right(count.toLocaleString("en-US"), 9)}   ${right(fixed(megabytes, 2), 9)}   ${right(fixed(ms, 1), 8)}   ${right(runs, 4)}`,
    );
  }

  const buffered = measureWrites(join(dir, "buffered.ndjson"), BUFFERED_WRITES);
  const flushStart = performance.now();
  buffered.db.flush();
  const flushMs = performance.now() - flushStart;
  buffered.db.close();

  const strict = measureWrites(join(dir, "strict.ndjson"), STRICT_WRITES, {
    durability: "strict",
  });
  strict.db.close();

  console.log("");
  console.log("Writes (one log per policy, timed over the loop)");
  console.log("");
  const writeRows = [
    { policy: "buffered", actions: BUFFERED_WRITES, elapsed: buffered.elapsed },
    { policy: "strict", actions: STRICT_WRITES, elapsed: strict.elapsed },
  ];
  console.log(
    `  ${left("policy", 8)}   ${right("actions", 8)}   ${right("total ms", 8)}   ${right("µs/op", 7)}`,
  );
  console.log(`  ${"-".repeat(8)}   ${"-".repeat(8)}   ${"-".repeat(8)}   ${"-".repeat(7)}`);
  for (const row of writeRows) {
    console.log(
      `  ${left(row.policy, 8)}   ${right(row.actions.toLocaleString("en-US"), 8)}   ${right(fixed(row.elapsed, 1), 8)}   ${right(fixed(usPerOp(row.elapsed, row.actions), 2), 7)}`,
    );
  }
  console.log("");
  console.log(
    `flush() after ${BUFFERED_WRITES.toLocaleString("en-US")} buffered writes: ${fixed(flushMs, 1)} ms`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
