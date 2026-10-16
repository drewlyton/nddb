# Error model — throwaway probe (#16)

**Throwaway.** This is a prototype artifact answering [issue #16](https://github.com/drewlyton/nddb/issues/16). It is not a design document, not a test suite, and not a base for `src/`.

## The question

What errors does nddb raise, how are they shaped, and does a failed write leave
memory and disk consistent? Resolved by triggering each failure for real and
looking at what a caller has to write to handle it.

Run:

```sh
pnpm build && node prototype/error-model/probe.mjs
```

Imports the built reader/writer from `dist/` (real export names: `readLog`,
`parseLog`, `serialiseAction`, `appendAction` from `log.js`; `classifyAction`
from `action.js`; `createWriter` from `write.js`).

## What the probe observed

| #   | Failure                                                 | Real shape                                                                                                    | Throws?                                                       |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Missing/empty `id`, `null` in a `put`, non-object value | `classifyAction → { ok:false, code, path? }`                                                                  | no — a **return value**                                       |
| 2   | `undefined` / function / symbol in a payload            | `JSON.stringify` drops the member; `classifyAction` still returns `ok`                                        | no — **silent data loss**                                     |
| 2   | `NaN` / `Infinity` in a payload                         | `JSON.stringify` writes `null`; `classifyAction` accepts it, then `readLog` calls the written line **damage** | no — **a write can plant damage**                             |
| 2   | `BigInt`                                                | `TypeError` from `JSON.stringify` during `serialiseAction`                                                    | yes, JS-native                                                |
| 2   | Cycle                                                   | `RangeError: Maximum call stack size exceeded` from `classifyAction`'s null walk                              | yes, JS-native                                                |
| 3   | `EACCES`                                                | Node `Error`, `code: "EACCES"`                                                                                | yes                                                           |
| 4   | `ENOSPC` (`/dev/full`)                                  | Node `Error`, `code: "ENOSPC"`                                                                                | yes                                                           |
| 5   | Path is a directory                                     | Node `Error`, `code: "EISDIR"` — surfaces at **first append**, not `open`                                     | yes                                                           |
| 6   | Malformed complete line                                 | `readLog → { status:"damaged", version, actions, damage:{ kind, line, … } }`                                  | returned; `open` shim throws `Error("damaged log at line N")` |
| 6   | Complete line failing the grammar                       | `damage: { kind:"invalid-action", line, code, path? }`                                                        | same                                                          |
| 6   | Newer format version                                    | `readLog → { status:"unsupported-version", version }` — **a refusal, not damage**                             | returned; `open` shim throws                                  |
| 7   | Read/write after `close()`                              | `Error("handle is closed")` / `Error("log writer is closed")`                                                 | yes                                                           |
| 8   | Failed `fsync`                                          | Node `Error`, `code: "EBADF"` (closed fd) or `"EINVAL"` (`/dev/null`)                                         | yes                                                           |
| 9   | Append fails mid-commit                                 | no new shape — the append throws and the fold never runs                                                      | yes, propagated                                               |

## Taxonomy: nddb-specific vs Node I/O

**Node I/O errors — do not invent a type.** `EACCES`, `ENOSPC`, `EISDIR`,
`EBADF`, `EINVAL` (and `EIO` in the wild) arrive as plain `Error` with `.code`,
`.errno`, `.syscall`, `.path`. They already carry everything a caller needs and
they are not nddb's semantics to name. nddb's only job is to (a) never swallow
them and (b) keep them from being confused with damage.

**nddb-specific failures — three genuinely different kinds:**

1. **Validation** — the action is malformed. Today `classifyAction` _returns_
   `{ ok:false, code, path? }`; it does not throw. That is the right internal
   shape (pure, total, no control flow by exception), and `ActionErrorCode` is
   already a closed union. The write boundary must turn it into either a return
   or a throw — but the code/path pair is the identity, not the message.
2. **Damage** — a complete line cannot be applied. Already structured
   (`LogDamage`: `invalid-json` / `invalid-header` / `invalid-action`, plus
   `line`, plus `code`/`path` for actions). Damage is _recoverable data_: it
   names a position and carries the valid prefix.
3. **Refusal** — a newer `{"nddb":N}`. Distinct from damage by construction;
   salvage deliberately does not bypass it (#21). It is only a version number.

Use-after-close is a fourth, small one: a lifecycle bug, not an I/O or data
condition.

## Recommendation: plain `Error` + a stable `code`, no exported classes

**Do not export error classes.** Plain `Error` (or, for validation, the existing
result object) carrying a stable `code` satisfies every branch the probe found,
and it respects AGENTS.md's "prefer functional style over OO" rule and #11's
"no exported class, no `instanceof`, no public prototype surface".

Why classes do not earn their place here:

- **The caller branches on a scalar anyway.** Every reaction the probe produced
  is `switch (err.code)` / `if (read.status === …)`. A class adds `instanceof`
  and nothing else a caller was going to use.
- **`instanceof` is the fragile branch.** It breaks across duplicate installs,
  ESM/CJS dual loading, and any future split of the package. A string `code` is
  stable across all of them. The repo already treats the handle as a closure
  rather than a prototype — exporting classes would put back the one OO surface
  it removed.
- **Damage is data, not an exception identity.** `line` + `kind` + prefix
  actions are a record you inspect (and salvage), not a category you catch.
  Modelling that as `class CorruptLogError` throws away the structure the reader
  already computed.
- **Validation is already total.** `classifyAction` returns; wrapping it in a
  class would force exception control flow into the pure core.

Proposed branch surface for the write/open boundary:

| Situation       | Signal                                                                                          | Caller writes                                                |
| --------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Bad action      | `err.code` = `ActionErrorCode` (`id-missing`, `id-empty`, `value-has-null`, …), plus `err.path` | `switch (err.code)` — no retry, it is a caller bug           |
| Damage at open  | `err.code = "NDDB_DAMAGED"`, `err.damage` = the `LogDamage` record                              | read `err.damage.line`; decide throw vs `onDamage:"salvage"` |
| Newer version   | `err.code = "NDDB_UNSUPPORTED_VERSION"`, `err.version`                                          | refuse; no salvage path exists                               |
| Use after close | `err.code = "NDDB_CLOSED"`                                                                      | fail the operation; never silently drop a write              |
| I/O             | Node's own `err.code` (`EACCES`, `ENOSPC`, …) passed through                                    | `if (err.code === "ENOSPC")`                                 |
| Failed fsync    | Node `err.code` (`EIO`/`EBADF`/…), surfaced                                                     | treat the write as **not durable**, never as success         |

Two rules make the table work:

- **Keep Node's `code` and namespace nddb's.** Node's are four uppercase letters;
  nddb's can be `NDDB_`-prefixed (or distinguished by the presence of
  `err.damage`/`err.version`). One `switch (err.code)` then covers everything
  without a type hierarchy.
- **Attach structured data as properties** (`err.code`, `err.path`,
  `err.damage`, `err.version`), and use `{ cause }` when wrapping a
  `JSON.stringify` failure so the native `TypeError` is not lost. A code alone
  cannot carry `damage.line`; a property can.

If a class is ever wanted for ergonomics, it should be a _non-exported_ thin
extension of `Error` that only sets `code` — never the branching mechanism.

## The failed-write consistency rule

**Append first, fold only on success.** The probe's `fold-then-append` ordering
left a `ghost` entity in the in-memory map that no log record backed; the next
`open()` would rebuild the map without it, so the caller believes a write it
never made. `append-then-fold` left the map at size 0 when the append threw —
memory and disk agreed.

```js
const commit = (action) => {
  writer.append(action); // the gate: throws on ENOSPC/EACCES/EISDIR/EIO
  applyAction(view, action); // reached only if the bytes landed
};
```

Consequences the probe made concrete:

- **Under `strict`, the gate is the fsync.** `append()` writes, then `fsyncSync`
  throws; the method throws, so the fold still does not run. A successful
  `append()` return is the only thing that may fold.
- **A failed `flush()` does not desync memory.** The bytes are already in the
  page cache and visible to every reader; only _durability_ was not achieved.
  The mutable view still matches what the file reads back as — the failed flush
  is a durability error, not a consistency one.
- **The write path repairs a torn tail before appending** (#9), so a failed
  first-write preparation (e.g. the "changed since it was read" guard, or
  `EISDIR`) must also abort before any fold. The probe confirms `open` itself is
  quiet about a directory path; the error is deferred to the first append.

## Could not be triggered here

- **EACCES as root** — the probe checks `process.getuid?.() === 0` and skips.
  This run was non-root (uid 1001), so EACCES was real.
- **A real disk-full filesystem** — `/dev/full` stands in; it is Linux-only, and
  the probe guards with `existsSync("/dev/full")`.
- **A genuine `EIO`** — needs failing hardware; `EBADF`/`EINVAL` stand in for the
  "fsync failed" shape.
- **A short `write(2)`** — not reproducible against `/dev/full` (it errors
  outright); the writer's `short write` guard remains untested by the probe.
