# Prototype — entity metadata exposed to readers (#6)

**Question.** When a caller fetches an entity, does `get`/`all` hand back the
database's own object or a copy? Can the caller mutate it without corrupting the
materialised view? And does an entity carry anything beyond the caller's fields?

**Throwaway.** This directory is a prototype for
[#6](https://github.com/drewlyton/nddb/issues/6). It is not production code, it
is not tested, and it should never be merged to `main`. The one file worth
lifting is the pure module inside `demo.html`.

## Run it

Double-click `demo.html`. It is a single self-contained file — no server, no
build, no install.

## What it explores

The settled parts are already baked in: an entity is exactly the caller's fields
plus `id` (issue #3), and it carries **no** `updatedAt`, version, or deleted
marker, because nddb reads no clock (issue #5). The demo prints the keys to show
that.

The open part is copy-on-read. Four policies are switchable live:

| Connection style     | `get()` hands back                   | Editing it                              |
| -------------------- | ------------------------------------ | --------------------------------------- |
| **Live object**      | the store's own object               | edits the view; the log never hears     |
| **Top-level copy**   | `{ ...entity }`                      | top-level edits safe, nested edits leak |
| **Independent copy** | `structuredClone(entity)`            | nothing reaches the view                |
| **Locked record**    | the store's own (deep-frozen) object | any edit throws                         |

Guided walkthroughs cover: rename without saving, edit a nested field, what's
inside a record, and the intended edit-then-save path.

## Measured cost at the #12 envelope

Node 24, ext4, one machine: 10,000 records of `{ title, done, tags[3], author }`
≈ **1 MiB** of payload. Indicative, not a benchmark.

| Work                                      | ms   |
| ----------------------------------------- | ---- |
| `materialize` 10,000 puts (once, at open) | 4.0  |
| `all()` live objects (baseline)           | 0.6  |
| `all()` shallow copy                      | 1.1  |
| `all()` deep copy (`structuredClone`)     | 34.6 |
| `all()` deep copy (`JSON` round-trip)     | 21.8 |
| 10,000 × `get()` + `structuredClone`      | 31.8 |
| deep-freeze every entity (write-time)     | 8.2  |

Takeaways: a single `get()` deep copy is ~3 µs; `all()` deep copy is ~20–35 ms
per call and grows with the whole dataset, so it is fine occasionally and
painful in a loop. Freezing moves the cost to the write and makes reads free,
but callers can only edit a record by spreading it first.

## Verdict

**Deep copy on read.** `get(id)` and `all()` return `structuredClone`d values, so
the materialised view never hands out a stored object. Entities stay plain
mutable values — no freezing, no proxies.

The mirror rule applies on the way in: `put`/`patch` currently share nested
objects with the caller's argument, so the view must be made to not alias
caller-owned data in either direction (see the resolution on #6).

Rejected:

- **Deep-freeze** — because `put`/`patch` share nested objects with the caller's
  argument, freezing the store would freeze the caller's own objects; avoiding
  that needs a clone on write anyway, at which point deep copy is friendlier.
- **Shallow copy** and **live object** — both leave nested values shared, which
  is the silent view-corruption this ticket exists to close.

Recorded as the resolution comment on
[#6](https://github.com/drewlyton/nddb/issues/6).
