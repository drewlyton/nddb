#!/usr/bin/env node
/**
 * nddb read/write characterisation.
 *
 * Complements `size-envelope.mjs` (which pins the documented envelope): this
 * one breaks open down into phases, measures the read surface and memory, and
 * reports write latency as percentiles rather than a mean. Run with
 * `pnpm bench` (which builds first and passes `--expose-gc`); every number is
 * indicative for one machine, not a guarantee.
 *
 * Warm reads: the log is in the page cache, so this is CPU cost, not disk.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { open } from "../dist/index.js";

const MB = 1024 * 1024;
const now = () => performance.now();

const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const percentile = (samples, p) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** Shapes let one axis (payload size) move while the others hold still. */
const shapes = {
  small: (i) => ({ id: `e${i}`, n: i }),
  typical: (i) => ({ id: `e${i}`, n: i, name: `entity number ${i}`, tags: ["a", "b", "c"] }),
  large: (i) => ({
    id: `e${i}`,
    n: i,
    name: `entity number ${i}`,
    bio: "x".repeat(400),
    tags: Array.from({ length: 20 }, (_, k) => `tag-${k}-${i}`),
  }),
};

/** One header line plus one `put` per entity, built as text to skip the write path. */
const generateLog = (count, shape = "typical") => {
  const make = shapes[shape];
  const lines = ['{"nddb":1}'];
  for (let i = 0; i < count; i += 1) {
    const { id, ...value } = make(i);
    lines.push(JSON.stringify({ op: "put", id, value }));
  }
  return `${lines.join("\n")}\n`;
};

const dir = mkdtempSync(join(tmpdir(), "nddb-rw-"));
const path = (name) => join(dir, name);
const megabytes = (file) => statSync(file).size / MB;

const openTimes = (file, runs) => {
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const started = now();
    const db = open(file);
    samples.push(now() - started);
    db.close();
  }
  return median(samples);
};

try {
  console.log(`nddb read/write — node ${process.version} ${process.platform}/${process.arch}`);
  console.log(`measuring in ${dir}`);
  console.log("");

  console.log("Read: where open() spends its time (100,000 typical, median of 3)");
  {
    const file = path("phase.ndjson");
    writeFileSync(file, generateLog(100_000));
    const read = [];
    const split = [];
    const parse = [];
    const full = [];
    for (let run = 0; run < 3; run += 1) {
      let started = now();
      const text = readFileSync(file, "utf8");
      read.push(now() - started);

      started = now();
      const lines = text.split("\n");
      split.push(now() - started);

      started = now();
      for (const line of lines) {
        if (line.trim() !== "") JSON.parse(line);
      }
      parse.push(now() - started);

      started = now();
      const db = open(file);
      full.push(now() - started);
      db.close();
    }
    const readMs = median(read);
    const splitMs = median(split);
    const parseMs = median(parse);
    const openMs = median(full);
    const parseOnly = readMs + splitMs + parseMs;
    console.log(
      `  readFileSync ${readMs.toFixed(0)} ms | split ${splitMs.toFixed(0)} ms | JSON.parse ${parseMs.toFixed(0)} ms`,
    );
    console.log(
      `  full open ${openMs.toFixed(0)} ms = ${((parseOnly / openMs) * 100).toFixed(0)}% parse + ${(((openMs - parseOnly) / openMs) * 100).toFixed(0)}% validate and fold`,
    );
  }

  console.log("");
  console.log("Read: open() scaling (typical, median of 3)");
  console.log("");
  console.log(
    `  ${"actions".padStart(9)}  ${"file MB".padStart(7)}  ${"open ms".padStart(7)}  ${"MB/s".padStart(5)}  ${"µs/action".padStart(9)}`,
  );
  for (const count of [10_000, 50_000, 100_000, 250_000, 500_000]) {
    const file = path(`open-${count}.ndjson`);
    writeFileSync(file, generateLog(count));
    const ms = openTimes(file, 3);
    console.log(
      `  ${count.toLocaleString("en-US").padStart(9)}  ${megabytes(file).toFixed(2).padStart(7)}  ${ms.toFixed(0).padStart(7)}  ${(megabytes(file) / (ms / 1000)).toFixed(0).padStart(5)}  ${((ms * 1000) / count).toFixed(2).padStart(9)}`,
    );
  }

  console.log("");
  console.log("Read: the read surface after open (100,000 typical)");
  {
    const file = path("read-surface.ndjson");
    writeFileSync(file, generateLog(100_000));
    const db = open(file);
    const gets = [];
    for (let run = 0; run < 1_000; run += 1) {
      const started = now();
      db.get("e50000");
      gets.push(now() - started);
    }
    const alls = [];
    for (let run = 0; run < 5; run += 1) {
      const started = now();
      db.all();
      alls.push(now() - started);
    }
    console.log(`  get() ${(median(gets) * 1000).toFixed(1)} µs (median of 1,000)`);
    console.log(`  all() ${median(alls).toFixed(0)} ms (median of 5, deep copy of every entity)`);
    db.close();
  }

  console.log("");
  console.log("Read: resident memory (250,000 typical)");
  {
    const file = path("memory.ndjson");
    writeFileSync(file, generateLog(250_000));
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
      const before = process.memoryUsage();
      const db = open(file);
      globalThis.gc();
      const after = process.memoryUsage();
      const heap = (after.heapUsed - before.heapUsed) / MB;
      console.log(
        `  heapUsed +${heap.toFixed(1)} MB (${((heap * MB) / 250_000).toFixed(0)} B/entity)`,
      );
      db.close();
      globalThis.gc();
      console.log(
        `  heapUsed after close: ${((process.memoryUsage().heapUsed - before.heapUsed) / MB).toFixed(1)} MB above baseline`,
      );
    } else {
      console.log("  run with --expose-gc to measure heap");
    }
  }

  console.log("");
  console.log("Write: per-put latency after warm-up (typical)");
  {
    const rows = [
      ["buffered", 50_000],
      ["strict", 5_000],
    ];
    console.log("");
    console.log(
      `  ${"policy".padEnd(8)}  ${"puts".padStart(6)}  ${"mean µs".padStart(8)}  ${"p50".padStart(7)}  ${"p95".padStart(7)}  ${"p99".padStart(7)}  ${"max".padStart(8)}`,
    );
    for (const [durability, count] of rows) {
      const file = path(`write-${durability}.ndjson`);
      writeFileSync(file, '{"nddb":1}\n');
      const db = open(file, { durability });
      for (let i = 0; i < 1_000; i += 1) db.put(shapes.typical(i));
      const samples = [];
      const started = now();
      for (let i = 0; i < count; i += 1) {
        const tick = now();
        db.put(shapes.typical(i));
        samples.push(now() - tick);
      }
      const total = now() - started;
      db.close();
      console.log(
        `  ${durability.padEnd(8)}  ${count.toLocaleString("en-US").padStart(6)}  ${((total * 1000) / count).toFixed(2).padStart(8)}  ${(median(samples) * 1000).toFixed(1).padStart(7)}  ${(percentile(samples, 95) * 1000).toFixed(1).padStart(7)}  ${(percentile(samples, 99) * 1000).toFixed(1).padStart(7)}  ${(Math.max(...samples) * 1000).toFixed(0).padStart(8)}`,
      );
    }
  }

  console.log("");
  console.log("Write: flush, first write, and entity size");
  {
    const file = path("flush.ndjson");
    const db = open(file);
    for (let i = 0; i < 50_000; i += 1) db.put(shapes.typical(i));
    const started = now();
    db.flush();
    const flushMs = now() - started;
    db.close();
    console.log(`  flush() after 50,000 buffered puts: ${flushMs.toFixed(1)} ms (one fsync)`);

    const fresh = path("first-write.ndjson");
    const freshDb = open(fresh);
    let tick = now();
    freshDb.put(shapes.typical(0));
    const first = now() - tick;
    tick = now();
    freshDb.put(shapes.typical(1));
    const second = now() - tick;
    freshDb.close();
    console.log(
      `  first put (create file, header, dir fsync): ${(first * 1000).toFixed(0)} µs | second put: ${(second * 1000).toFixed(0)} µs`,
    );

    console.log("");
    console.log(
      `  ${"shape".padEnd(8)}  ${"file MB".padStart(7)}  ${"total ms".padStart(8)}  ${"µs/put".padStart(7)}  ${"MB/s".padStart(5)}`,
    );
    for (const shape of ["small", "typical", "large"]) {
      const shapeFile = path(`shape-${shape}.ndjson`);
      const shapeDb = open(shapeFile);
      const begin = now();
      for (let i = 0; i < 20_000; i += 1) shapeDb.put(shapes[shape](i));
      const elapsed = now() - begin;
      shapeDb.close();
      console.log(
        `  ${shape.padEnd(8)}  ${megabytes(shapeFile).toFixed(2).padStart(7)}  ${elapsed.toFixed(0).padStart(8)}  ${((elapsed * 1000) / 20_000).toFixed(2).padStart(7)}  ${(megabytes(shapeFile) / (elapsed / 1000)).toFixed(0).padStart(5)}`,
      );
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
