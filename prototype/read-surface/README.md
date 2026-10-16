# Prototype — read surface (#13)

**Question.** What can a caller read, and at what cost? Is the surface deliberately
minimal, with callers filtering `all()` by hand, or do named reads (`filter`,
`find`, `count`, `keys`, an iterator) earn their place over a `Map`?

**Throwaway.** A prototype for [#13](https://github.com/drewlyton/nddb/issues/13),
built on [#6](https://github.com/drewlyton/nddb/issues/6)'s copy-on-read rule. Not
production code, never merged to `main`.

## Run it

Double-click `demo.html`. Self-contained; no server, no build.

## What it explores

The demo runs each candidate read over the same seed view and counts **entity
copies** under #6. The candidate surface is `get`, `all`, `count`, `has`, `keys`,
`filter`, `find`, and a custom iterator. It also renders three honest call sites
by hand and shows the code each surface needs.

## Verdict

**`get(id)` and `all()`, and nothing else. Filtering is the caller's, over the
array `all()` returns.**

```ts
db.get("todo_1"); //                                       Entity | undefined
db.all(); //                                               Entity[]
db.all().filter((t) => t.tags.includes("urgent")); //      filtering, by hand
db.all().find((t) => t.author.name === "Ada"); //          finding, by hand
db.all().length; //                                        counting, by hand
for (const todo of db.all()) render(todo); //              iteration, by hand
```

### Why

- **`all()` returns a real array, so filtering, finding, mapping, counting and
  iteration already exist.** A named `filter`/`find`/`keys`/iterator renames an
  array method — ceremony that expands the contract and the type surface for no
  new capability.
- **Named predicate reads are a correctness hazard, not just ceremony.** The demo
  confirms it: `filter(pred)` hands the predicate the **stored** entity, so a
  predicate that mutates corrupts the view — the exact trap #6 closed. The safe
  version copies before calling the predicate, which is `all().filter(...)` with
  extra steps.
- **`count`/`has`/`keys` are the only candidates with any case**, because they
  avoid the copy that #6 makes every read pay. But they are still one-liners over
  `all()` except for the copy cost, and adding a read later is a two-way door
  (non-breaking) while removing one is a one-way door. Start minimal; add `count`
  only if a real hot spot appears.
- **Nothing here needs an index.** Every predicate read is O(n) over the
  materialised `Map`. No proposed method forces index maintenance, which keeps
  the map's "indexes are out of scope" boundary true.

### Per-candidate verdicts

| Candidate                  | Verdict         | Why                                                                           |
| -------------------------- | --------------- | ----------------------------------------------------------------------------- |
| `get(id)`                  | keep            | core lookup, O(1) + one copy                                                  |
| `all()`                    | keep            | core list; an array makes filter/find/map/length/iteration free               |
| `filter(p)` / `find(p)`    | reject          | renames `all().filter`; predicate sees the live entity unless it copies first |
| custom `[Symbol.iterator]` | reject          | `all()` is already iterable                                                   |
| `keys()`                   | reject          | `all().map(t => t.id)`; O(n) either way, no capability gained                 |
| `count()`                  | reject for v0.1 | O(1) vs `all().length`, but a narrow case and cheap to add later              |
| `has(id)`                  | reject          | `get(id) !== undefined`; saves one ~3 µs copy                                 |

## Cost, stated plainly

10,000 records ≈ 1 MiB, one deep copy ≈ 3 µs, `all()` ≈ 20–35 ms (measured on
the #6 prototype).

| Read                   | Copy                                   | ms at 10k | Without it you write      |
| ---------------------- | -------------------------------------- | --------- | ------------------------- |
| `get(id)`              | 1 entity                               | ~0.003    | —                         |
| `all()`                | every entity                           | ~20–35    | —                         |
| `all().length`         | every entity                           | ~20–35    | `count()` — not shipped   |
| `all().filter(p)`      | every entity, then predicate on copies | ~20–35    | `filter(p)` — not shipped |
| `all().map(t => t.id)` | every entity                           | ~20–35    | `keys()` — not shipped    |

`get` is O(1); everything reached through `all()` is O(n). No read is O(log n) or
O(1) except `get`.

## Recorded

Resolution comment on
[#13](https://github.com/drewlyton/nddb/issues/13). The liftable part of
`demo.html` is the `createHandle` read surface.
