# Agents

nddb is a tiny single-file database: one NDJSON action log, entities
materialized by replaying `put`, `patch`, and `delete` actions.

## Design first

The design is **settled**, and it lives as issues on the repo's
[`wayfinder:map`](https://github.com/drewlyton/nddb/issues/1): action grammar,
patch semantics, durability contract, identity, handle model, and on-disk
format. Read the map before changing the public surface, and prefer the recorded
decision over intuition.

The core is implemented under `src/`. The remaining `build` tickets are
documentation (#29), packaging (#30), and verification (#31); work belongs
against one of those rather than alongside them.

## Invariants

Keep the public contract honest; `README.md` carries the detail.

- `buffered` is not power-loss durable.
- One handle per file, machine-wide.
- `patch` treats arrays as opaque values.

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
pnpm fmt:check   # oxfmt --check
pnpm build       # emit dist/
```
