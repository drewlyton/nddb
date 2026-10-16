# Prototype — write surface (#14)

**Question.** What can a caller write? Which verbs, do they return anything, and
is a batch or transaction really missed? How does `put`'s create-or-replace read
when you are holding an entity you just fetched?

**Throwaway.** A prototype for [#14](https://github.com/drewlyton/nddb/issues/14).
Not production code, never merged to `main`.

## Run it

```sh
pnpm build && node prototype/write-surface/probe.mjs
```

It exercises the candidate handle against the real writer (`src/write.ts`) and
materialised view (`src/entity.ts`) — a real NDJSON file on disk, not a mock.

## Verdict

**Three verbs on the handle — `put(entity)`, `patch(id, patch)`, `delete(id)` —
all returning `void`, `put` create-or-replace, and no batch.**

```ts
db.put({ id: "todo_1", title: "buy milk", done: false }); // create
db.patch("todo_1", { done: true }); // change one field
db.patch("todo_1", { tags: null }); // remove a field
db.delete("todo_1"); // remove the entity
db.delete("todo_1"); // no-op, not an error
```

### Why

- **All three verbs, on the handle.** `put`/`patch`/`delete` are the settled
  action vocabulary (#2); the write surface is exactly those three methods, no
  more.
- **`put` is create-or-replace, and there is no insert-only or update-only
  variant.** The probe shows a re-`put` dropping every field it does not carry.
  That is the honest meaning of a whole-entity write in a log whose unit is the
  action; a caller changing one field uses `patch`, which already exists.
- **No batch or transaction.** Each action is one atomic append (#8: one
  `write(2)` per action, no `position`). A hypothetical `putAll` would still be
  N appends — no fewer syscalls, and no atomicity across them — and an
  append-only log has no rollback for a half-landed batch. Bulk seeding is a
  loop: the probe seeds 5,000 entities in ~26 ms (~5 µs/put, folded in memory).
- **Writes return `void`.** A write is a command, not a query; the caller
  already holds what it wrote, and can read back with `get` (#13). Returning the
  entity would couple the write path to the read path and #6's copy rule for no
  gain.
- **`delete` is idempotent.** Deleting a missing id is a no-op, never an error
  (#2), so bulk cleanup needs no existence checks.
- **A write can fail, loudly.** Validation or I/O failure throws — no result
  object, no silent drop. The error's shape is #16's. The consistency rule that
  falls out: **append first, fold into memory only on success**, so a failed
  write never leaves the view ahead of the file.

### The create-or-replace call site

```ts
const todo = db.get("todo_1"); // a copy (#6)
todo.title = "renamed";
db.put(todo); // replace wholesale, id included
```

This is the intended update path and it reads cleanly, which is the point: with
`put` as replace, "I fetched it, changed it, put it back" is one line of intent
rather than a diff.

## Recorded

Resolution comment on [#14](https://github.com/drewlyton/nddb/issues/14).
