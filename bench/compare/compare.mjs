#!/usr/bin/env node
/**
 * nddb vs. the two closest alternatives, on one small-prototype workload.
 *
 * This is a *reference* harness, not part of nddb: `better-sqlite3` and `lowdb`
 * are deliberately not dependencies of the library. Install and run it on its
 * own:
 *
 *   cd bench/compare && npm install && node compare.mjs
 *
 * Results are indicative for one machine and one workload. Read the settings
 * each tool is given (durable vs. not) before quoting a number.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";
import { JSONFileSyncPreset } from "lowdb/node";

import { open } from "../../dist/index.js";

const N = 10_000;
const READS = 20_000;
const WRITES = 300;
const MB = 1024 * 1024;

const dir = mkdtempSync(join(tmpdir(), "nddb-compare-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const now = () => performance.now();
const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const entity = (i) => ({ id: `e${i}`, n: i, name: `entity number ${i}`, tags: ["a", "b", "c"] });
const json = (i) => JSON.stringify(entity(i));

const line = () => console.log("-".repeat(78));
const row = (what, ms, ops = 1, extra = "") =>
  console.log(
    `  ${what.padEnd(36)} ${ms.toFixed(1).padStart(8)} ms ${((ms * 1000) / ops).toFixed(1).padStart(8)} µs/op  ${extra}`,
  );
/** File size, counting SQLite's WAL sidecar so the sqlite row is honest. */
const mib = (file) => {
  let total = statSync(file).size;
  for (const suffix of ["-wal", "-shm"]) {
    try {
      total += statSync(`${file}${suffix}`).size;
    } catch {
      // No sidecar; nothing to add.
    }
  }
  return `${(total / MB).toFixed(2)} MB`;
};

console.log(`\n== Bulk seed ${N.toLocaleString()} entities ==`);
line();
{
  const file = `${dir}/nddb-buffered.ndjson`;
  const started = now();
  const db = open(file);
  for (let i = 0; i < N; i += 1) db.put(entity(i));
  db.flush();
  db.close();
  row("nddb buffered + flush", now() - started, N, mib(file));
}
{
  const file = `${dir}/nddb-strict.ndjson`;
  const started = now();
  const db = open(file, { durability: "strict" });
  for (let i = 0; i < N; i += 1) db.put(entity(i));
  db.close();
  row("nddb strict (fsync per put)", now() - started, N, mib(file));
}
{
  const file = `${dir}/sqlite.db`;
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec("CREATE TABLE entities (id TEXT PRIMARY KEY, doc TEXT)");
  const insert = db.prepare("INSERT INTO entities (id, doc) VALUES (?, ?)");
  const started = now();
  db.transaction(() => {
    for (let i = 0; i < N; i += 1) insert.run(`e${i}`, json(i));
  })();
  row("sqlite WAL/FULL, one transaction", now() - started, N, mib(file));
  db.close();
}
{
  const file = `${dir}/lowdb.json`;
  const started = now();
  const db = JSONFileSyncPreset(file, { entities: [] });
  db.data.entities = Array.from({ length: N }, (_, i) => entity(i));
  db.write();
  row("lowdb sync whole-file write", now() - started, N, mib(file));
}

console.log(`\n== Load everything into application memory ==`);
line();
{
  const file = `${dir}/nddb-buffered.ndjson`;
  const started = now();
  const db = open(file);
  const elapsed = now() - started;
  const count = db.all().length;
  db.close();
  row("nddb open (read + replay to Map)", elapsed, N, `${count} entities`);
}
{
  const db = new Database(`${dir}/sqlite.db`);
  db.pragma("journal_mode = WAL");
  const started = now();
  const rows = db.prepare("SELECT id, doc FROM entities").all();
  const raw = now() - started;
  row("sqlite SELECT all (raw, no app copy)", raw, N, `${rows.length} rows`);

  const build = now();
  const map = new Map();
  for (const r of rows) {
    const parsed = JSON.parse(r.doc);
    parsed.id = r.id;
    map.set(parsed.id, parsed);
  }
  row("sqlite SELECT + JSON.parse + Map", raw + (now() - build), N, `${map.size} entities`);
  db.close();
}
{
  const file = `${dir}/lowdb.json`;
  const started = now();
  const db = JSONFileSyncPreset(file, { entities: [] });
  const elapsed = now() - started;
  row("lowdb open (read + JSON.parse)", elapsed, N, `${db.data.entities.length} entities`);
}

console.log(`\n== Point read by id (median of ${READS.toLocaleString()}) ==`);
line();
{
  const db = open(`${dir}/nddb-buffered.ndjson`);
  const samples = [];
  for (let i = 0; i < READS; i += 1) {
    const tick = now();
    db.get(`e${i % N}`);
    samples.push(now() - tick);
  }
  db.close();
  row("nddb get() (in-memory Map)", median(samples), 1);
}
{
  const db = new Database(`${dir}/sqlite.db`);
  db.pragma("journal_mode = WAL");
  const get = db.prepare("SELECT doc FROM entities WHERE id = ?");
  const samples = [];
  for (let i = 0; i < READS; i += 1) {
    const tick = now();
    get.get(`e${i % N}`);
    samples.push(now() - tick);
  }
  db.close();
  row("sqlite indexed SELECT by id", median(samples), 1);
}
{
  const db = JSONFileSyncPreset(`${dir}/lowdb.json`, { entities: [] });
  const samples = [];
  for (let i = 0; i < READS; i += 1) {
    const tick = now();
    db.data.entities.find((e) => e.id === `e${i % N}`);
    samples.push(now() - tick);
  }
  row("lowdb Array.find (O(n) scan)", median(samples), 1);
}

console.log(`\n== One write to an existing store (median of ${WRITES}) ==`);
line();
{
  const db = open(`${dir}/nddb-strict.ndjson`, { durability: "strict" });
  const samples = [];
  for (let i = 0; i < WRITES; i += 1) {
    const tick = now();
    db.put(entity(N + i));
    samples.push(now() - tick);
  }
  db.close();
  row("nddb strict put (fsync)", median(samples), 1);
}
{
  const db = open(`${dir}/nddb-buffered.ndjson`);
  const samples = [];
  for (let i = 0; i < WRITES; i += 1) {
    const tick = now();
    db.put(entity(N + i));
    samples.push(now() - tick);
  }
  db.close();
  row("nddb buffered put (no fsync)", median(samples), 1);
}
{
  const db = new Database(`${dir}/sqlite.db`);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  const insert = db.prepare("INSERT INTO entities (id, doc) VALUES (?, ?)");
  const samples = [];
  for (let i = 0; i < WRITES; i += 1) {
    const tick = now();
    insert.run(`e${N + i}`, json(N + i));
    samples.push(now() - tick);
  }
  db.close();
  row("sqlite autocommit insert (WAL/FULL)", median(samples), 1);
}
{
  const db = JSONFileSyncPreset(`${dir}/lowdb.json`, { entities: [] });
  const samples = [];
  for (let i = 0; i < WRITES; i += 1) {
    const tick = now();
    db.data.entities.push(entity(N + i));
    db.write();
    samples.push(now() - tick);
  }
  row(
    "lowdb write whole file (no fsync)",
    median(samples),
    1,
    `${db.data.entities.length} entities`,
  );
}

console.log(`\n== Scan every entity, no copy (median of 5) ==`);
line();
{
  const file = `${dir}/scan.ndjson`;
  const lines = ['{"nddb":1}'];
  for (let i = 0; i < N; i += 1) {
    const { id, ...value } = entity(i);
    lines.push(JSON.stringify({ op: "put", id, value }));
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  const db = open(file);
  const samples = [];
  for (let run = 0; run < 5; run += 1) {
    let visited = 0;
    const tick = now();
    db.forEach(() => {
      visited += 1;
    });
    samples.push(now() - tick);
    if (visited !== N) throw new Error(`forEach visited ${visited}, expected ${N}`);
  }
  db.close();
  row("nddb forEach (borrowed, in place)", median(samples), N);
}
{
  const db = JSONFileSyncPreset(`${dir}/scan.json`, {
    entities: Array.from({ length: N }, (_, i) => entity(i)),
  });
  const samples = [];
  for (let run = 0; run < 5; run += 1) {
    let visited = 0;
    const tick = now();
    for (const _ of db.data.entities) visited += 1;
    samples.push(now() - tick);
    if (visited !== N) throw new Error(`lowdb visited ${visited}, expected ${N}`);
  }
  row("lowdb raw array for..of", median(samples), N);
}
{
  const file = `${dir}/scan.db`;
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec("CREATE TABLE entities (id TEXT PRIMARY KEY, doc TEXT)");
  const insert = db.prepare("INSERT INTO entities (id, doc) VALUES (?, ?)");
  db.transaction(() => {
    for (let i = 0; i < N; i += 1) insert.run(`e${i}`, json(i));
  })();
  const statement = db.prepare("SELECT id, doc FROM entities");
  const samples = [];
  for (let run = 0; run < 5; run += 1) {
    let visited = 0;
    const tick = now();
    for (const r of statement.iterate()) {
      const parsed = JSON.parse(r.doc);
      parsed.id = r.id;
      visited += 1;
    }
    samples.push(now() - tick);
    if (visited !== N) throw new Error(`iterate visited ${visited}, expected ${N}`);
  }
  db.close();
  row("sqlite iterate + JSON.parse", median(samples), N);
}
