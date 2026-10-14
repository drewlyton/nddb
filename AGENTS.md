# Agents

nddb is a tiny single-file database: one NDJSON action log, entities
materialized by replaying `put` and `patch` actions.

## Design first

The public API and durability semantics are being settled on the repo's
wayfinding map (see the `wayfinder:map` issue). Before changing the public
surface, check the map and its decision tickets.

## Code style

- Prefer functional style over OO: pure functions, immutable data, avoid class
  hierarchies and inheritance.
- Keep the core free of dependencies. A prototype database should not drag a
  tree of packages behind it.
- Comments document intent for future maintainers. Don't narrate what the code
  does or explain choices visible in the code.

## Commands

```sh
pnpm test        # vitest, single run
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm fmt         # oxfmt
pnpm build       # emit dist/
```
