/**
 * Throwaway prototype for #14, "Write surface".
 *
 * Exercises put / patch / delete from real call sites against the real writer
 * (src/write.ts) and materialised view (src/entity.ts), and answers: what may a
 * caller write, does a write return anything, and is a batch really missed?
 *
 * Run:  pnpm build && node prototype/write-surface/probe.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyAction, materialize } from "../../dist/entity.js";
import { readLog } from "../../dist/log.js";
import { createWriter } from "../../dist/write.js";

const hr = (title) =>
  console.log(`\n${"─".repeat(4)} ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
const show = (label, value) => console.log(`   ${label.padEnd(34)} ${value}`);

/** The smallest candidate handle: the write surface under test. */
const open = (path) => {
  const read = readLog(path);
  if (read.status !== "ok") {
    throw new Error(`cannot open: ${read.status}`);
  }
  const view = materialize(read.actions);
  const writer = createWriter(path);

  const commit = (action) => {
    // Write first, fold only on success: a failed append must not touch memory.
    writer.append(action);
    applyAction(view, action);
  };

  return {
    path,
    put: (entity) => {
      const { id, ...value } = entity;
      commit({ op: "put", id, value });
    },
    patch: (id, patch) => commit({ op: "patch", id, patch }),
    delete: (id) => commit({ op: "delete", id }),
    get: (id) => view.get(id),
    all: () => [...view.values()],
    flush: () => writer.flush(),
    close: () => writer.close(),
  };
};

const dir = mkdtempSync(join(tmpdir(), "nddb-write-surface-"));
const path = join(dir, "todos.ndjson");

try {
  const db = open(path);

  hr("seed a list — the everyday write");
  console.log("   for (const todo of todos) db.put(todo);");
  for (const todo of [
    { id: "todo_1", title: "buy milk", done: false, tags: ["home"] },
    { id: "todo_2", title: "write README", done: true, tags: ["docs"] },
    { id: "todo_3", title: "ship v0.1", done: false, tags: ["work"] },
  ]) {
    db.put(todo);
  }
  show("put returns", String(db.put({ id: "todo_4", title: "x" })));
  show("view", JSON.stringify(db.all().map((t) => t.id)));

  hr("update one field");
  console.log('   db.patch("todo_1", { done: true });');
  db.patch("todo_1", { done: true });
  show("todo_1.done", String(db.get("todo_1").done));

  hr("remove a field (patch null)");
  console.log('   db.patch("todo_3", { tags: null });');
  db.patch("todo_3", { tags: null });
  show("todo_3 hasOwn tags", String(Object.hasOwn(db.get("todo_3"), "tags")));

  hr("delete");
  console.log('   db.delete("todo_2");');
  db.delete("todo_2");
  show("todo_2", String(db.get("todo_2")));
  console.log('   db.delete("todo_2");  // again — idempotent');
  let secondDelete;
  try {
    db.delete("todo_2");
    secondDelete = "no throw";
  } catch (error) {
    secondDelete = `threw ${error.message}`;
  }
  show("delete of a missing id", secondDelete);

  hr("create-or-replace, holding an entity you just fetched");
  console.log("   const t = db.get('todo_1'); t.title = 'renamed'; db.put(t);");
  const fetched = db.get("todo_1");
  fetched.title = "renamed";
  db.put(fetched);
  show("todo_1.title", String(db.get("todo_1").title));
  console.log('   db.put({ id: "todo_1", title: "only title" });  // replaces wholesale');
  db.put({ id: "todo_1", title: "only title" });
  show("todo_1 after replace", JSON.stringify(db.get("todo_1")));

  hr("does a write return the entity? an ack? nothing?");
  show("put", String(db.put({ id: "todo_9" })));
  show("patch", String(db.patch("todo_9", { done: true })));
  show("delete", String(db.delete("todo_9")));
  console.log("   All undefined: a write is a command, not a query. Read back what you need.");

  hr("bulk seed of thousands — is a batch missed?");
  const bulkDir = mkdtempSync(join(tmpdir(), "nddb-bulk-"));
  const bulkPath = join(bulkDir, "bulk.ndjson");
  const bulk = open(bulkPath);
  const N = 5000;
  const start = performance.now();
  for (let i = 0; i < N; i += 1) {
    bulk.put({ id: `todo_${i}`, title: `todo ${i}`, done: false, tags: ["bulk"] });
  }
  const loopMs = performance.now() - start;
  bulk.flush();
  bulk.close();
  show(
    `${N} × put (then one flush)`,
    `${loopMs.toFixed(1)} ms  (${((loopMs * 1000) / N).toFixed(2)} µs/put)`,
  );
  show("lines in the bulk file", String(readFileSync(bulkPath, "utf8").trim().split("\n").length));
  rmSync(bulkDir, { recursive: true, force: true });

  hr("a batch could not help even if it existed");
  console.log("   #8: one write(2) per action, no position. A putAll would still be N appends,");
  console.log(
    "   so it saves JS loop overhead and nothing else — no atomicity, no fewer syscalls.",
  );
  console.log("   The log is append-only, so there is no rollback for a half-landed batch anyway.");

  db.flush();
  db.close();

  hr("the file it wrote");
  console.log(readFileSync(path, "utf8").trimEnd());
} finally {
  rmSync(dir, { recursive: true, force: true });
}
