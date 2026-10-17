# nddb

A tiny single-file database. Everything lives in one NDJSON (newline-delimited
JSON) file that is an **action log**: entities are materialized by replaying
`put`, `patch`, and `delete` actions in order.

- **One file.** The log is the source of truth; entities are derived from it.
- **Eager and in-memory.** `open` reads and replays the whole log into a `Map`.
  Reads never touch disk.
- **One appended line per write.** Each action is one `write(2)`.
- **Synchronous and dependency-free.** No method returns a Promise. TypeScript,
  Node ≥22, ESM-only, zero runtime dependencies.

Pre-release: the public surface is deliberately **not frozen** — a breaking
major is acceptable.

## Quick start

```ts
import { open } from "nddb";

const db = open("todos.ndjson"); // reads and replays the whole log, now

db.put({ id: "todo_1", title: "write the README", done: false });
db.patch("todo_1", { done: true });

db.get("todo_1");
// { title: "write the README", done: true, id: "todo_1" }

db.close(); // optional; flushes
```

The first write creates the file — the header line, then the action:

```ndjson
{"nddb":1}
{"op":"put","id":"todo_1","value":{"title":"write the README","done":false}}
{"op":"patch","id":"todo_1","patch":{"done":true}}
```

Annotate the type and the compiler rejects a bad patch before it reaches disk:

```ts
type Todo = { title: string; done: boolean };
const db = open<Todo>("todos.ndjson");

db.patch("todo_1", { done: true }); // ok
db.patch("todo_1", { nope: 1 }); // compile error
```

## One handle per file — machine-wide

**At most one nddb handle may exist for a given file, across every process on
the machine.** This is the one rule whose breach fails silently, so it is not a
footnote.

| Case                                                                         | Verdict                                                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Two `open` calls in one process, same path                                   | **Enforced.** The realpath-keyed refcounted cache returns the same handle. A contradicting `durability` throws `NDDB_DURABILITY_CONFLICT`. |
| Two processes, each with an nddb handle                                      | **Unsupported and undefined.**                                                                                                             |
| An external reader — `cat`, `grep`, `jq`, `tail -f` — while a writer appends | **Fine.** A reader cannot damage the log.                                                                                                  |
| A second nddb handle only to read                                            | **Unsupported.** There is no read-only mode, so every handle is a potential writer.                                                        |

Cross-process access is undefined because a second handle holds a second
**snapshot**: each handle materializes once at `open` and never re-reads the
file. A violator does not corrupt the log — a single `write(2)` on an
`O_APPEND` fd lands intact — it simply reads stale data. The failure is
**staleness, not corruption**.

There is no locking, no lock file, and no heartbeat. Nothing detects a
cross-process violator in general; the one place nddb looks is the pre-flight
guard before a destructive truncate-repair, which refuses if the file changed
behind the handle (see [Recovery](#recovery)). Otherwise the invariant is
documentation, not enforcement.

## Durability

`open` takes a `durability` policy, fixed for the handle's lifetime. Both
policies write **byte-identical files** — they differ only in _when_ `fsync`
happens.

| Event                      | `buffered` (default)                                                                                                      | `strict`                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A write returns            | Appended and visible to every process.                                                                                    | Appended, visible, **and on stable media**.                                    |
| `db.flush()` returns       | Everything written so far is on stable media.                                                                             | Already durable; `fsync` is a no-op.                                           |
| `db.close()` returns       | Everything written so far is on stable media.                                                                             | Everything is on stable media.                                                 |
| `process.exit` / `SIGKILL` | Every write so far survives — the page cache outlives the process.                                                        | Every write survives.                                                          |
| OS crash / power loss      | **Recent writes may be lost, and the file may be damaged beyond a torn tail**, because writeback order is not guaranteed. | Every returned write survives, in order; at most the in-flight append is torn. |

**`buffered` means "not fsynced", never "not written".** There is no userspace
buffer: each action reaches the kernel in one `write(2)` before the call
returns, which is what makes the SIGKILL guarantee hold. It is **not
power-loss durable**.

**`strict`** (`{ durability: "strict" }`) fsyncs before the write returns. A
returned write is on stable media. A **failed fsync surfaces as an error**
(`err.code` from Node, e.g. `EIO`) and means the write is **not durable** — the
caller must not treat it as success.

`flush()` is synchronous and returns once the data is durable; it is a no-op
under `strict`. `close()` flushes, releases the handle, and is optional and
idempotent — an unclosed handle loses only the flush guarantee.

The cost of the promise, measured on ext4: the raw append syscall is ~2 µs
buffered and ~670 µs under `strict`; the public `put` (validate, serialise,
fold) is ~6.5 µs buffered. Bulk loads should use `buffered` and `flush()` once
at the end; see [Size envelope](#size-envelope) for the numbers.

## Size envelope

nddb is designed for logs in the **single-digit-megabyte range — on the order
of tens of thousands of actions**. This is documented, not enforced.

Measured with `pnpm bench` on one machine (Linux/x64, Node v24.21.0, ext4),
over an entity with a few scalar fields and a short array. Eager `open` is the
median of 5 runs (3 at 100k):

| Actions | File size | Eager `open` (read + fold) |
| ------: | --------: | -------------------------: |
|  10,000 |   0.95 MB |                     ~19 ms |
|  50,000 |   4.88 MB |                     ~84 ms |
| 100,000 |   9.79 MB |                    ~165 ms |

Writes through the public `put` (validate, serialise, one `write(2)`, fold):

| Policy   | Actions |   Total | Per `put` |
| -------- | ------: | ------: | --------: |
| buffered |  50,000 | ~0.33 s |   ~6.6 µs |
| strict   |  10,000 |  ~6.0 s |   ~600 µs |

`flush()` after the 50,000 buffered writes costs ~4 ms (one `fsync`).

Reproduce with `pnpm bench` (builds `dist/` first; see [`bench/`](bench/README.md)
for read/write speed, latency percentiles, and memory). The numbers move run to
run and are only meaningful on a real filesystem — on tmpfs `fsync` is a no-op,
so the `strict` rows do not apply there.

So the promise holds: 50,000 actions is a 4.88 MB log that `open` folds in
~84 ms and that `buffered` writes at ~6.6 µs per action. The top of the range
is real, not comfortable — 100,000 actions is already 9.79 MB and a ~165 ms
blocking `open` — so treat "tens of thousands" as the ceiling it is. The
ceiling is about blocking latency and resident memory, not correctness: the same
code opens a million actions in a few seconds.

- `open` is **O(file size)** and **blocking**: it reads the whole file and
  replays every action before returning.
- Every write blocks for its durability policy.
- There is **no compaction in v0.1**, so the file only grows with writes.

Beyond that size, a caller wants a different tool.

## Patch: arrays are opaque

`patch` is RFC 7386 JSON Merge Patch, adopted verbatim. The most likely trap:

- Nested objects merge recursively.
- A `null` at an **object-member** position removes that member.
- **Arrays are opaque values, replaced wholesale.** You cannot edit inside one.
  To change one tag, resend the whole list.
- A target member that is not an object is replaced.

```ts
db.put({ id: "t", tags: ["a", "b"], meta: { x: 1, y: 2 } });
db.patch("t", { tags: ["c"], meta: { x: null } });

db.get("t"); // { tags: ["c"], meta: { y: 2 }, id: "t" }
// tags is ["c"], NOT ["a", "b", "c"]; meta.x is gone
```

`null` means exactly one thing — "remove this member" — so it is illegal
everywhere else:

| Position                                           | Rule                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| A `null` at an object-member position in a `patch` | Removes that member.                                                        |
| Any `null` in a `put` payload                      | Rejected (`value-has-null`).                                                |
| A `null` inside an array, in either verb           | Rejected (`value-has-null` in a `put`, `patch-null-in-array` in a `patch`). |
| `patch: null` (the whole patch)                    | Rejected (`patch-not-object`); it does **not** delete.                      |

No entity can ever hold a `null`. `patch` on a missing id **creates** the
entity (upsert), and merge is **idempotent**, so applying the same line twice
is harmless. The log stores the caller's patch **verbatim** — the log records
intent, not merely effect. To remove an entity, use `delete`.

## Recovery

There are two tiers, split by whether the record ever completed.

**A torn tail is expected and benign.** Bytes after the last newline are an
unfinished record. They are dropped on read and never mark the handle damaged.
On the **first write**, the writer truncates back to the last newline before
appending — after a pre-flight guard that refuses if the file changed behind
the handle. This happens at first-write time, never at `open`.

**A complete line that cannot be applied is real damage.** Replay **stops at
the first damaged line and never skips ahead** — applying later actions would
drop committed data and patch the wrong base.

- Default: `open` throws `NDDB_DAMAGED` with `err.damage` naming the line.
- `{ onDamage: "salvage" }`: `open` returns a **read-only handle** over the
  valid prefix. It is **permanently read-only** — writes on it throw
  `NDDB_DAMAGED`. There is **no repair method**; repair is offline and manual
  (truncate, restore a backup, or copy the good prefix into a new file).

Under `strict`, every returned write is durable and ordered, so the only
possible damage is a torn tail. **Salvage exists for `buffered`**, where an OS
crash or power loss can also leave a damaged interior.

## Versions

The current format version is **v1**, and a **headerless file is v1**. A
`{"nddb":1}` header may appear on line 1.

| Reader meets             | Result                                                       |
| ------------------------ | ------------------------------------------------------------ |
| Its own version or older | Read normally.                                               |
| A newer version          | `open` throws `NDDB_UNSUPPORTED_VERSION` with `err.version`. |

Refusal is **not damage**, so `onDamage: "salvage"` does **not** bypass it —
salvaging bytes whose meaning you cannot interpret is exactly the silent
misread the marker exists to prevent.

There are **no migrations and no in-place upgrades**. v1 is the only version
that has existed, so "older" is about the future: when a v2 arrives, a v1 file
has **no in-process path forward** in v0.1 — there is no migration, and
compaction (which is not in v0.1) would require a current-version input anyway.
A file written by a newer nddb has exactly one remedy: **upgrade nddb**.

## On-disk format

```ndjson
{"nddb":1}
{"op":"put","id":"todo_1","value":{"title":"write the README","done":false}}
{"op":"patch","id":"todo_1","patch":{"done":true}}
{"op":"delete","id":"todo_1"}
```

- Compact JSON, one action per line, LF-terminated, UTF-8 with **no BOM**.
- Fixed envelope key order: `op`, `id`, then `value` or `patch`. The payload is
  written **verbatim**, so the caller's key order is preserved.
- `{"nddb":1}` is optional on line 1, written only when nddb **creates** the
  file, and **never retrofitted**. It is identified by the reserved `nddb` key
  _and_ the absence of `op`, so a corrupted first line is never mistaken for
  metadata.
- Read tolerance: a leading BOM is stripped, CRLF is accepted, and blank or
  whitespace-only lines are skipped. The writer never emits any of these.
- `.ndjson` is the documented extension and is never enforced.

`wc -l` is one greater than the action count whenever a header is present, and
`head -1` shows metadata rather than the first action.

## Errors

nddb's own failures are plain `Error`s with a stable `err.code`; there are no
exported error classes and nothing to `instanceof`. Branch on `code` and read
the structured data off the error.

| `err.code`                                  | Meaning                                                                    | Extra                              |
| ------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| `not-an-object`                             | Action is not a JSON object.                                               |                                    |
| `op-missing` / `op-unknown`                 | No `op`, or an `op` that is not `put`/`patch`/`delete`.                    |                                    |
| `id-missing` / `id-not-string` / `id-empty` | `id` is absent, not a string, or `""`.                                     |                                    |
| `value-missing` / `value-not-object`        | A `put` has no `value`, or `value` is not an object.                       |                                    |
| `value-has-null`                            | A `null` appears in a `put` payload.                                       | `err.path`                         |
| `not-json`                                  | A value JSON cannot carry faithfully.                                      | `err.path`                         |
| `patch-missing` / `patch-not-object`        | A `patch` has no `patch`, or it is not an object (`patch: null` included). |                                    |
| `patch-null-in-array`                       | A `null` is reached through an array in a `patch`.                         | `err.path`                         |
| `NDDB_DAMAGED`                              | Damage at `open`, or any write to a salvaged handle.                       | `err.damage` — `{ kind, line, … }` |
| `NDDB_UNSUPPORTED_VERSION`                  | The file is newer than this build.                                         | `err.version`                      |
| `NDDB_CLOSED`                               | A method was used on a closed handle.                                      |                                    |
| `NDDB_DURABILITY_CONFLICT`                  | A second `open` contradicts the live handle's `durability`.                |                                    |

`not-json` catches the values `JSON.stringify` would drop or mangle:
`undefined`, functions, symbols, `BigInt`, non-finite numbers (`NaN`,
`Infinity`), and cycles.

Two write-path refusals have no code yet and surface as bare `Error`s: the
stale-file guard ("changed since it was read") and a short write. #16 left their
shape open; a code is expected before compaction inherits the guard.

**Node's I/O codes pass through untouched** — `EACCES`, `ENOSPC`, `EISDIR`,
`EIO`, and so on. A failed fsync is a Node error too, and it means the write is
not durable. The write path validates and serialises **before** appending and
folds into memory **only on success**, so a failed write never leaves the view
ahead of the file.

## API surface

`open(path, options?)` returns a `Db<T>`. The exported TSDoc types are the
per-member reference; the notes below are the semantics the types do not carry.

| Option       | Values                     | Default      |
| ------------ | -------------------------- | ------------ |
| `durability` | `"buffered"` \| `"strict"` | `"buffered"` |
| `onDamage`   | `"throw"` \| `"salvage"`   | `"throw"`    |

| Member             | Notes                                      |
| ------------------ | ------------------------------------------ |
| `path`             | Read-only resolved absolute path.          |
| `get(id)`          | O(1); returns a deep copy.                 |
| `all()`            | O(n); a fresh array of deep copies.        |
| `forEach(visit)`   | O(n); visits the stored entities, no copy. |
| `put(entity)`      | Create-or-replace; `id` is required.       |
| `patch(id, patch)` | RFC 7386 merge; upserts a missing id.      |
| `delete(id)`       | Hard delete; idempotent.                   |
| `flush()`          | Synchronous; no-op under `strict`.         |
| `close()`          | Flushes; idempotent and optional.          |

- `Entity<T> = { readonly id: string } & T`. `T` defaults to
  `Record<string, unknown>` for the schemaless case.
- `DeepPartial<T>` is the patch parameter: recursive, `null` removes a member.
  `id` is not patchable — a patch cannot rename.
- `id` is a **required, caller-supplied, non-empty, opaque string**. nddb never
  generates one — call `crypto.randomUUID()` yourself. The envelope's `id`
  always wins at the top level of a payload; a nested `id` is ordinary data.
- The view never aliases caller data: `get`/`all` return deep copies, and
  `put`/`patch` copy payloads in.
- `forEach` is the deliberate exception, for scans that cannot afford a copy.
  Its callback receives the **stored** entity: mutate it or keep a reference
  and the in-memory view drifts from the log. Return `false` to stop early.

Deliberately absent from v0.1: batch and transaction APIs, `count`/`filter`/
`find`/`keys`, and `Symbol.dispose`. Filtering is the caller's, in memory over
`all()` or `forEach`.

## Non-goals

- Concurrency and multi-process access (see the single-writer rule above).
- Query languages, indexes, or joins.
- Migrations, schemas, or runtime validation.
- Compaction — there is none in v0.1.
- Replacing SQLite for anything that matters.

## Development

```sh
pnpm install
pnpm build       # emit dist/
pnpm test        # vitest, single run
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm fmt         # oxfmt
```

Requires Node ≥22. ESM-only, zero runtime dependencies.

## License

MIT
