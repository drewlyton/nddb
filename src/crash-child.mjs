// Fault-injection child for src/crash.test.ts — not part of the build.
//
// A real SIGKILL cannot tear a completed single write(2): once write(2)
// returns, the bytes are in the shared page cache and outlive the process
// (#20). So `torn` mode injects the torn bytes at the fault point — the exact
// on-disk state an OS crash mid-append leaves — and the parent then SIGKILLs
// this process for real. The kill is genuine; the tear is injected, not
// produced by the kill.

import { closeSync, openSync, writeSync } from "node:fs";

const [indexUrl, dbPath, durability, countArg, mode] = process.argv.slice(2);

const { open } = await import(indexUrl);
const count = Number(countArg);
const db = open(dbPath, { durability });

for (let i = 0; i < count; i++) {
  db.put({ id: `a${i}`, i });
  process.stdout.write(`ack a${i}\n`);
}

if (mode === "torn") {
  const fd = openSync(dbPath, "a");
  try {
    // No trailing newline: an unfinished record, exactly what a crash during
    // an append leaves behind.
    writeSync(fd, '{"op":"put","id":"torn"');
  } finally {
    closeSync(fd);
  }
}

// The fault point is reached; block so the parent can kill us mid-life.
process.stdout.write("ready\n");
setInterval(() => {}, 1 << 30);
