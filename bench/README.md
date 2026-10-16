# Benchmarks

Two dependency-free, repeatable scripts, plus a reference harness that compares
nddb with the closest alternatives. Numbers are **indicative for one machine**,
not a guarantee — but the shape (linear read, fsync-bound strict writes) is the
design, not the hardware.

```sh
pnpm bench            # builds dist/, then runs both scripts
pnpm build && node bench/size-envelope.mjs
pnpm build && node --expose-gc bench/read-write.mjs

cd bench/compare && npm install && node compare.mjs   # nddb vs lowdb vs sqlite
```

- **`size-envelope.mjs`** pins the documented envelope: eager `open` at
  10k/50k/100k actions and `put` cost for both durability policies. Summary
  numbers live in the README's [Size envelope](../README.md#size-envelope).
- **`read-write.mjs`** characterises read and write speed: where `open` spends
  its time, scaling, the read surface, resident memory, latency percentiles,
  and payload-size effects. Needs `--expose-gc` for the memory row.
- **`compare/`** is a reference harness, not a dependency of nddb. It installs
  `better-sqlite3` and `lowdb` on its own and runs one small-prototype workload
  against all three.

## Representative results

Linux/x64, Node v24.21.0, ext4 at `/tmp` (so `fsync` is real), warm page cache.
The benchmark entity is a few scalar fields plus a short array.

### Read

| actions |     file |  `open` |         |                |
| ------: | -------: | ------: | ------: | -------------: |
|  10,000 |  0.89 MB |   22 ms | 41 MB/s | 2.19 µs/action |
|  50,000 |  4.59 MB |  129 ms | 36 MB/s | 2.58 µs/action |
| 100,000 |  9.22 MB |  263 ms | 35 MB/s | 2.63 µs/action |
| 250,000 | 23.52 MB |  659 ms | 36 MB/s | 2.64 µs/action |
| 500,000 | 47.37 MB | 1534 ms | 31 MB/s | 3.07 µs/action |

- **`open` is linear — no cliff past the envelope.** ~35 MB/s, ~2.6 µs/action,
  holding from 10k to 500k. The ceiling the README states is about blocking
  latency and memory, not an algorithmic wall.
- **At 100k, `open` is ~47% `JSON.parse` and ~53% validate-and-fold.** Reading
  the file and splitting is ~5%. `classifyAction` (which walks every payload to
  enforce the null ban) plus `Map.set` and the id-stamped spread cost slightly
  more than parsing itself. If `open` ever needs to be faster, that is the
  target.
- **`get(id)` is ~2 µs** — one deep copy of a small entity.
- **`all()` is ~2 µs per entity, i.e. a deep copy of everything.** At 100k it
  is ~200 ms: about the cost of re-opening the log. That copy is deliberate
  ([#6](https://github.com/drewlyton/nddb/issues/6)); callers that only need a
  few entities should use `get` rather than `all().find(...)`.
- **Memory is ~245 B per entity**, so 250k entities ≈ 58 MB of heap. Heap does
  not always return to baseline immediately after `close()` (V8 retention), but
  the materialized view is released.

### Write (warm, steady state)

|   policy |   mean |    p50 |     p95 |     p99 |    max |
| -------: | -----: | -----: | ------: | ------: | -----: |
| buffered | 8.0 µs | 6.9 µs | 10.0 µs | 25.1 µs | 4.2 ms |
|   strict | 627 µs | 594 µs |  865 µs | 1.05 ms | 3.4 ms |

- **`buffered` writes are ~7 µs at p50, but the tail is 1000× the median.**
  Rare multi-millisecond stalls (GC or kernel writeback) dominate the maximum.
  For a write-heavy loop, budget on p99 (~25 µs), not the mean.
- **`strict` is fsync-bound and variable**: ~0.6 ms at p50, but p99 over 1 ms
  and a maximum of several ms. That is the price of durability per write, and
  it is why bulk loads should use `buffered` + one `flush()`.
- **`flush()` after 50,000 buffered writes is ~3.5 ms** — one `fsync`.
- **The first write is ~0.7 ms**, creating the file, writing the header, and
  the best-effort parent-directory `fsync`; later writes are ~20 µs.
- **Cost scales with payload size** (buffered, 20k puts): small 5.9 µs/put
  (7 MB/s), typical 8.8 µs (10 MB/s), large 17.8 µs (41 MB/s). Larger payloads
  amortise the fixed per-action overhead better.

## Compared to alternatives

One workload — 10,000 entities of `{id, n, name, tags}` — against a whole-file
JSON store (`lowdb` 7, sync) and an embedded SQL engine (`better-sqlite3` 13).
Run it with `cd bench/compare && npm install && node compare.mjs`.

| workflow               | nddb                                 | lowdb (JSON file)                  | better-sqlite3               |
| ---------------------- | ------------------------------------ | ---------------------------------- | ---------------------------- |
| bulk seed 10k, durable | 102 ms buffered+flush / 6.3 s strict | 11 ms (no fsync)                   | **30 ms** in one transaction |
| load all into memory   | 22 ms warm / 48 ms first open        | 12 ms                              | 5 ms raw / 16 ms + Map       |
| point read by id       | **2.0 µs** (in-memory)               | 89 µs (O(n) scan)                  | 4.4 µs (indexed)             |
| one write, durable     | 654 µs (strict)                      | 7.1 ms — rewrites **every** record | 723 µs (autocommit)          |
| one write, best-effort | **6.7 µs**                           | same 7.1 ms                        | ~3 µs inside a transaction   |
| file size              | 0.89 MB                              | 1.42 MB                            | 1.03 MB                      |

What the table means:

- **nddb is a read-mostly, single-process store, and that is where it competes.**
  In-memory `get` beats an indexed SQL point query and buries a linear scan. The
  trade is that `open` pays for the whole log before the first read.
- **Durable bulk seeding is the weak spot.** A per-write `fsync` is ~630 µs, so
  10k durable puts is ~6 s. SQLite's one transaction does the same in ~30 ms.
  The mitigation is nddb's own guidance: seed `buffered` and `flush()` once
  (102 ms — still ~3× SQLite, but sane).
- **A single durable write costs the same everywhere** (~650–720 µs) because it
  is one `fsync`; nddb is not special there.
- **Whole-file JSON is fast at load and hopeless at incremental writes.** lowdb
  loads 2× faster than nddb, but every write rewrites all records — 7.1 ms at
  10k, growing O(n).

Settings and caveats, because they change the comparison:

- **SQLite** stores `id` in a column plus a JSON `doc` blob (the document-store
  pattern); real columns would be faster. `/tmp` WAL at `synchronous = FULL`,
  the durable setting — its _default_ is `synchronous = NORMAL`, documented as a
  slight durability loss and faster than the row above.
- **lowdb**'s whole-file write is tmp-file + rename with **no `fsync`**: atomic,
  not durable.
- **nddb `open`** is JIT-sensitive; the warm number is the one to compare.

## Caveats

- **Reads are CPU measures.** The file is in the page cache, so this is parse
  plus fold, not disk. A cold read adds I/O.
- **`fsync` needs a real filesystem.** On tmpfs `fsync` is a no-op, so the
  `strict` row, the `flush()` row, and the first-write cost are meaningless
  there. The script prints the directory it measures in.
- **Latency percentiles move run to run**, especially the maxima; read the
  order of magnitude, not the digit.
