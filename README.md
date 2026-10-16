# nddb

A tiny single-file database. Everything lives in one NDJSON (newline-delimited
JSON) file that is an **action log**: entities are materialized by replaying a
sequence of `put`, `patch`, and `delete` actions in order.

Built for quick prototypes and small apps that need durable storage with
minimal storage, memory, and performance overhead — not for scale.

```ts
import { open } from "nddb";

const db = open("todos.ndjson");

db.put({ id: "todo_1", title: "write the README", done: false });
db.patch("todo_1", { done: true });

db.get("todo_1"); // { id: "todo_1", title: "write the README", done: true }
```

The file it writes is just JSON lines, one action per line:

```ndjson
{"op":"put","id":"todo_1","value":{"title":"write the README","done":false}}
{"op":"patch","id":"todo_1","patch":{"done":true}}
```

## Status

**Pre-release, and the code in `src/` is stale scaffolding.** The design is
settled: the action grammar, patch semantics, durability contract, identity
rules, on-disk format, and API shape are all decided, and the decisions live as
issues on the [`wayfinder:map`](https://github.com/drewlyton/nddb/issues/1). The
build is planned there too, as `build`-labelled child tickets.

What is in `src/` today is the original walking skeleton. It predates the design
and contradicts it — `type` where the format says `op`, a shallow spread where
the design says RFC 7386, no header, unguarded parsing, and reads that hand back
live objects. It is being replaced ticket by ticket. **Do not depend on it.**

## Design in one paragraph

The log is the source of truth. `open(path)` replays the whole file into an
in-memory `Map` of entities, and every write appends one line and updates the
map. Reads never touch the disk. This makes `nddb` trivially inspectable
(`cat`, `grep`, `tail -f`) and cheap to back up, at the cost of loading the
whole file into memory and never compacting it — acceptable when "small" is the
point.

## Non-goals

- Concurrency, multi-process access, or a server.
- Query languages, indexes, or joins.
- Migrations, schemas, or validation.
- Replacing SQLite for anything that matters.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm fmt
```

## License

MIT
