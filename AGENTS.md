# Agents

nddb is a tiny single-file database: one NDJSON action log, entities
materialized by replaying `put`, `patch`, and `delete` actions.

## Design first

The design is **settled**, and it lives as issues on the repo's
[`wayfinder:map`](https://github.com/drewlyton/nddb/issues/1): action grammar,
patch semantics, durability contract, identity, handle model, and on-disk
format. Read the map before changing the public surface, and prefer the recorded
decision over intuition.

The build is planned as `build`-labelled child tickets of that map. Work belongs
against one of those tickets rather than alongside them.

`src/` is still the original walking skeleton and contradicts several of those
decisions. It is being replaced; treat it as scaffolding, not as a base.

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
