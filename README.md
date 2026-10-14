# nddb

A tiny single-file database. Everything lives in one NDJSON (newline-delimited
JSON) file that is an **action log**: entities are materialized by replaying a
sequence of `put` and `patch` actions in order.

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
{"type":"put","id":"todo_1","value":{"title":"write the README","done":false}}
{"type":"patch","id":"todo_1","patch":{"done":true}}
```

## Status

**Walking skeleton.** The toolchain, build, tests, and a minimal `put`/`patch`
replay are in place. The public API, durability guarantees, and patch semantics
are still being decided on the repo's wayfinding map — see the `wayfinder:map`
issue. Expect the API to move.

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
