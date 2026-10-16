/**
 * Throwaway prototype for #16, "Error model".
 *
 * Triggers every nddb failure for real against the built reader/writer and the
 * host filesystem, and prints what a caller actually has to write to react.
 *
 * Run:  pnpm build && node prototype/error-model/probe.mjs
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyAction } from "../../dist/action.js";
import { applyAction, materialize } from "../../dist/entity.js";
import { appendAction, parseLog, readLog, serialiseAction } from "../../dist/log.js";
import { createWriter } from "../../dist/write.js";

// ─── report plumbing ────────────────────────────────────────────────────────

const SECTION_WIDTH = 74;
const hr = (title) =>
  console.log(
    `\n${"─".repeat(4)} ${title} ${"─".repeat(Math.max(0, SECTION_WIDTH - title.length))}`,
  );
const show = (label, value) => console.log(`   ${String(label).padEnd(30)} ${value}`);
const caller = (line) => console.log(`   ↳ caller: ${line}`);

const json = (value) => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? "undefined" : text;
  } catch (error) {
    return `<throws ${error.name}: ${error.message.split("\n")[0]}>`;
  }
};

/** The full observable surface of a thrown value. */
const describe = (error) => {
  if (!(error instanceof Error)) {
    return `non-Error thrown: ${json(String(error))}`;
  }
  const bits = [`name=${error.name}`, `message=${json(error.message)}`];
  if ("code" in error && error.code !== undefined) bits.push(`code=${json(error.code)}`);
  if (error.cause !== undefined)
    bits.push(`cause=${json(error.cause?.message ?? String(error.cause))}`);
  return bits.join("  ");
};

/** Run a thunk and capture the thrown value instead of propagating it. */
const attempt = (fn) => {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    return { threw: true, error };
  }
};

/** Print a thrown value, or the value when nothing was thrown. */
const reportAttempt = (label, outcome) => {
  if (outcome.threw) {
    show(label, "THREW");
    show("  error", describe(outcome.error));
  } else {
    show(label, `returned ${json(outcome.value)}`);
  }
};

const scratchRoot = mkdtempSync(join(tmpdir(), "nddb-error-model-"));

// ─── 1. input validation at write time ──────────────────────────────────────

hr("1. input validation at write time — classifyAction returns, it does not throw");

const badActions = [
  ["missing id", { op: "put", value: { title: "x" } }],
  ["empty id", { op: "put", id: "", value: { title: "x" } }],
  ["null inside a put value", { op: "put", id: "t1", value: { tags: ["a", null] } }],
  ["non-object value", { op: "put", id: "t1", value: [1, 2] }],
];

for (const [label, built] of badActions) {
  const check = classifyAction(built);
  show(label, `ok=${check.ok}${check.ok ? "" : ` code=${check.code} path=${json(check.path)}`}`);
}
console.log("   All four are return values, never exceptions:");
console.log("     const check = classifyAction(action);");
console.log("     if (!check.ok) switch (check.code) {");
console.log(
  "       case 'id-missing': case 'id-empty': case 'id-not-string': → caller bug, no retry",
);
console.log("       case 'value-has-null': → reject, name check.path");
console.log("       default: → reject");
console.log("     }");
caller(
  "branch on the returned code, not on an exception; a rejected write never reaches the file.",
);

// ─── 2. non-JSON-representable values ───────────────────────────────────────

hr("2. non-JSON-representable values — silent loss vs throw");

const cyclic = { a: 1 };
cyclic.self = cyclic;

const payloads = [
  ["undefined member", { a: undefined }],
  ["function member", { a: () => 1 }],
  ["symbol member", { a: Symbol("s") }],
  ["NaN", { a: NaN }],
  ["Infinity", { a: Infinity }],
  ["BigInt", { a: 10n }],
  ["cycle", cyclic],
];

for (const [label, payload] of payloads) {
  const stringify = attempt(() => JSON.stringify(payload));
  const stringified = stringify.threw
    ? `THREW ${stringify.error.name}: ${stringify.error.message.split("\n")[0]}`
    : stringify.value;
  // The same payload as the write path would see it: validate, then serialise.
  const check = attempt(() => classifyAction({ op: "put", id: "x", value: payload }));
  const writePath = check.threw
    ? `classifyAction THREW ${check.error.name}: ${check.error.message.split("\n")[0]}`
    : !check.value.ok
      ? `classifyAction REJECTED code=${check.value.code}`
      : (() => {
          const out = attempt(() => serialiseAction(check.value.action));
          return out.threw
            ? `classifyAction ok, serialise THREW ${out.error.name}`
            : `classifyAction ok, wrote ${out.value.replace(/\n$/, "")}`;
        })();
  show(label, `JSON.stringify → ${stringified}`);
  show("  write path", writePath);
}

show(
  "NaN through classifyAction",
  `ok=${classifyAction({ op: "put", id: "x", value: { a: NaN } }).ok} (accepted!)`,
);

console.log("   Silent data loss: undefined, function, symbol (member vanishes).");
console.log("   Silent *shape* loss: NaN / Infinity become null — which is exactly the value");
console.log("   the grammar forbids, so classifyAction ACCEPTS the write and readLog later");
console.log("   calls the resulting line damage. A write can plant real damage.");
console.log("   BigInt throws at serialise; a cycle never even gets there — findNull recurses");
console.log("   forever and explodes the stack as a RangeError.");
caller("a validation walk over the payload must reject undefined/function/symbol/BigInt and");
caller("non-finite numbers before serialise; JSON.stringify alone is not a validator.");

const planted = join(scratchRoot, "planted.ndjson");
writeFileSync(planted, serialiseAction({ op: "put", id: "x", value: { a: NaN } }));
const plantedRead = readLog(planted);
show("NaN write read back", `${plantedRead.status} damage=${json(plantedRead.damage)}`);
caller("therefore classifyAction must run AFTER payload normalisation, or it misses NaN.");

// ─── 3. EACCES ──────────────────────────────────────────────────────────────

hr("3. EACCES — no permission to append");

const eaccesDir = join(scratchRoot, "eacces");
const eaccesPath = join(eaccesDir, "locked.ndjson");
if (process.getuid?.() === 0) {
  console.log(
    "   skipped: running as root, where mode bits do not deny access (EACCES is untestable as root).",
  );
} else {
  mkdirSync(eaccesDir);
  writeFileSync(eaccesPath, "");
  chmodSync(eaccesPath, 0o000);
  show("openSync(path, 'a')", describe(attempt(() => openSync(eaccesPath, "a")).error));
  show("appendFileSync(path)", describe(attempt(() => appendFileSync(eaccesPath, "x\n")).error));
  show(
    "createWriter(path).append",
    describe(
      attempt(() => createWriter(eaccesPath).append({ op: "put", id: "x", value: {} })).error,
    ),
  );
  chmodSync(eaccesPath, 0o600);
  caller(
    'catch (e) { if (e.code === "EACCES") → the path is not writable; report path + code, no retry loop }',
  );
}

// ─── 4. ENOSPC ──────────────────────────────────────────────────────────────

hr("4. ENOSPC — disk full");

if (existsSync("/dev/full")) {
  show(
    "appendFileSync('/dev/full')",
    describe(attempt(() => appendFileSync("/dev/full", "x\n")).error),
  );
  const fullFd = attempt(() => {
    const fd = openSync("/dev/full", "a");
    try {
      writeSync(fd, "x\n");
    } finally {
      closeSync(fd);
    }
  });
  show("openSync+writeSync", describe(fullFd.error));
  caller(
    'catch (e) { if (e.code === "ENOSPC") → out of space; the append did not land, memory must not fold }',
  );
} else {
  console.log("   skipped: /dev/full is not present on this platform.");
}

// ─── 5. path is a directory ─────────────────────────────────────────────────

hr("5. EISDIR — the path is a directory");

const dirAsFile = join(scratchRoot, "a-directory");
mkdirSync(dirAsFile);
show("openSync(dir, 'a')", describe(attempt(() => openSync(dirAsFile, "a")).error));
show(
  "createWriter(dir).append",
  describe(attempt(() => createWriter(dirAsFile).append({ op: "put", id: "x", value: {} })).error),
);
console.log(
  "   createWriter() itself is quiet — the fd is only acquired at the first write (#11),",
);
console.log("   so the I/O error surfaces at first append, not at open.");
caller(
  'catch (e) { if (e.code === "EISDIR") → the caller passed a directory; surface it, do not treat as damage }',
);

// ─── 6. damaged log at open ─────────────────────────────────────────────────

hr("6. damaged log at open — damage vs refusal");

const damagedJson = join(scratchRoot, "damaged-json.ndjson");
writeFileSync(
  damagedJson,
  [
    '{"nddb":1}',
    '{"op":"put","id":"a","value":{"n":1}}',
    '{"op":"put","id":"b","value":{"n":2',
    '{"op":"put","id":"c","value":{"n":3}}',
  ].join("\n") + "\n",
);

const damagedAction = join(scratchRoot, "damaged-action.ndjson");
writeFileSync(damagedAction, '{"nddb":1}\n{"op":"put","id":"","value":{}}\n');

const unsupported = join(scratchRoot, "unsupported.ndjson");
writeFileSync(unsupported, '{"nddb":2}\n{"op":"put","id":"a","value":{}}\n');

const tornTail = join(scratchRoot, "torn-tail.ndjson");
writeFileSync(
  tornTail,
  '{"nddb":1}\n{"op":"put","id":"a","value":{"n":1}}\n{"op":"put","id":"b","va',
);

const cases = [
  ["malformed complete JSON line", damagedJson],
  ["complete line failing the grammar", damagedAction],
  ["newer format version", unsupported],
  ["incomplete trailing record", tornTail],
];

for (const [label, path] of cases) {
  const read = readLog(path);
  const detail =
    read.status === "damaged"
      ? `damage=${json(read.damage)}  prefixActions=${read.actions.length}`
      : read.status === "unsupported-version"
        ? `version=${read.version}  (refusal, not damage)`
        : `actions=${read.actions.length}`;
  show(label, `readLog → ${read.status}  ${detail}`);
  if (read.status === "damaged") {
    const opened = attempt(() => materialize(read.actions));
    show(
      "  salvage prefix",
      opened.threw ? "threw" : `materialised ${opened.value.size} entit(ies)`,
    );
  }
}

console.log("   What open() throws today (readActions shim, awaiting #28's onDamage):");
for (const [label, path] of cases.slice(0, 3)) {
  const thrown = attempt(() => {
    const read = readLog(path);
    if (read.status === "ok") return "ok";
    if (read.status === "damaged") throw new Error(`damaged log at line ${read.damage.line}`);
    throw new Error(`unsupported log version ${read.version}; this build reads up to 1`);
  });
  show(`  ${label}`, describe(thrown.error));
}
console.log("   Damage is recoverable data (prefix + position); refusal is only a version number.");
console.log(
  "   #21: salvage does not bypass a refusal — you cannot salvage a format you cannot read.",
);
caller(
  "if (read.status === 'damaged') → report damage.line + damage.kind, offer salvage explicitly",
);
caller("if (read.status === 'unsupported-version') → refuse; no salvage path exists by design");

// torn tail must be benign (contrast)
show(
  "torn tail is",
  readLog(tornTail).status === "ok" ? "ok — dropped as a torn tail" : "unexpected",
);
show(
  "parseLog is pure",
  `parseLog(text) → ${parseLog('{"op":"put","id":"z","value":{}}\n').status}`,
);

// ─── 7. use after close ─────────────────────────────────────────────────────

hr("7. use after close — the handle throws, it does not no-op");

const realWriter = createWriter(join(scratchRoot, "closed.ndjson"));
realWriter.close();
reportAttempt(
  "real writer.append after close",
  attempt(() => realWriter.append({ op: "put", id: "x", value: {} })),
);
reportAttempt(
  "real writer.flush after close",
  attempt(() => realWriter.flush()),
);
show("real writer.close twice", "no throw — close is idempotent (#11)");

/** The shape #11 says open() returns: a plain closure, no class. */
const makeHandle = (records) => {
  let closed = false;
  const live = () => {
    if (closed) throw new Error("handle is closed");
  };
  return {
    get(id) {
      live();
      return records.get(id);
    },
    put(entity) {
      live();
      records.set(entity.id, entity);
    },
    close() {
      closed = true;
    },
  };
};

const handle = makeHandle(new Map());
handle.close();
reportAttempt(
  "closure handle.get after close",
  attempt(() => handle.get("x")),
);
reportAttempt(
  "closure handle.put after close",
  attempt(() => handle.put({ id: "x" })),
);
caller(
  'catch (e) { if (e.message === "handle is closed") → a programming bug; do not swallow a dropped write }',
);
caller("a stable code (e.g. e.code === 'closed') beats sniffing the message.");

// ─── 8. failed fsync ────────────────────────────────────────────────────────

hr("8. failed fsync — the write became undurable");

const fsyncPath = join(scratchRoot, "fsync.ndjson");
const fsyncFd = openSync(fsyncPath, "a");
writeSync(fsyncFd, '{"op":"put","id":"a","value":{}}\n');
closeSync(fsyncFd);
reportAttempt(
  "fsyncSync on a closed fd",
  attempt(() => fsyncSync(fsyncFd)),
);
reportAttempt(
  "fsyncSync on /dev/null",
  attempt(() => {
    const fd = openSync("/dev/null", "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }),
);
console.log("   A failed fsync means the bytes are in the page cache, not on stable media.");
console.log(
  "   strict: append → writeSync lands the line, then fsyncSync throws; append() throws,",
);
console.log("           so the caller must not record the write as durable. #8: never swallowed.");
console.log(
  "   flush(): flushes and lets the same error escape; close() still releases the fd in a finally.",
);
console.log(
  "   The parent-directory fsync is the one deliberate exception — best effort, swallowed (#8).",
);
caller(
  'catch (e) { if (e.code) → "not durable"; retry flush or fail the operation, never assume success }',
);

// ─── 9. failed-write consistency ────────────────────────────────────────────

hr("9. failed-write consistency — append first, fold only on success");

const ghost = { op: "put", id: "ghost", value: { n: 1 } };

// Correct ordering against a real failing append: memory untouched.
const committedFirst = new Map();
const correct = attempt(() => {
  appendAction("/dev/full", ghost); // throws ENOSPC
  applyAction(committedFirst, ghost); // never reached
});
show("append-then-fold: append threw", String(correct.threw));
show("  memory after failure", `size=${committedFirst.size} (consistent: nothing folded)`);

// Buggy ordering: memory ahead of disk.
const foldedFirst = new Map();
const buggy = attempt(() => {
  applyAction(foldedFirst, ghost); // memory updated first
  appendAction("/dev/full", ghost); // throws ENOSPC
});
show("fold-then-append: append threw", String(buggy.threw));
show(
  "  memory after failure",
  `size=${foldedFirst.size} → phantom ${json([...foldedFirst.keys()])}`,
);
console.log("   The buggy order leaves an entity readable in memory that no log records; the next");
console.log("   open() rebuilds without it, so the caller believes a write it never made.");

// The success path on a real file is where the rule is visible.
const goodPath = join(scratchRoot, "consistent.ndjson");
const good = createWriter(goodPath);
const view = new Map();
const commit = (action) => {
  good.append(action); // must succeed
  applyAction(view, action); // fold only on success
};
commit({ op: "put", id: "e1", value: { n: 1 } });
commit({ op: "put", id: "e2", value: { n: 2 } });
good.close();
const disk = readLog(goodPath);
show("success path: memory ids", json([...view.keys()]));
show("  disk ids", json(disk.actions.map((a) => a.id)));
show("  in sync", String(view.size === disk.actions.length));
caller(
  "commit(action) { writer.append(action); applyAction(view, action); } — the append is the gate.",
);

// ─── wrap up ────────────────────────────────────────────────────────────────

hr("cleanup");
rmSync(scratchRoot, { recursive: true, force: true });
show("removed", scratchRoot);
show("remains", String(existsSync(scratchRoot)));

console.log("\nprobe complete.");
