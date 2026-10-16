# Type-surface prototype — THROWAWAY

Throwaway prototype for nddb issue **#15, "TypeScript type surface"**. Not
shipped, not a proposal, no tests. Its only job is to answer: **does a type
parameter earn its keep against `Record<string, unknown>`?**

Files:

- `type-surface.ts` — candidate signatures + usage snippets, compile-checked.
- `tsconfig.json` — extends the repo root, `include: ["type-surface.ts"]`,
  `noEmit: true`, so the repo's `strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, and `verbatimModuleSyntax` all apply.

## The question

`open<T>(path)` with an entity type parameter? How is `id` typed? Is `Entity<T>`
worth it? Are branded ids worth it? Does inference work at a realistic call
site? (Spec: `id` is `string` and required at every write site — #3; `patch` is
RFC 7386 merge patch where a `null` member removes — #4; the surface is
synchronous — #12.)

## Candidate signatures

```ts
export type Entity<T extends Record<string, unknown>> = { readonly id: string } & T;

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | null }
    : T;

export type Db<T extends Record<string, unknown>> = {
  readonly path: string;
  get(id: string): Entity<T> | undefined;
  all(): Entity<T>[];
  put(entity: Entity<T>): void;
  patch(id: string, patch: DeepPartial<T>): void;
  delete(id: string): void;
  flush(): void;
  close(): void;
};

export function open<T extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
  options?: OpenOptions,
): Db<T>;
```

## What compiled cleanly

Everything. `pnpm exec tsc -p prototype/type-surface/tsconfig.json` exits `0`
with the exact shape above — **the compiler forced no design change.** The typed
call site (`put` with `id`, nested `patch`, array replacement, `author: null`
removal), the untyped default call site, and all `@ts-expect-error` assertions
pass. `exactOptionalPropertyTypes` accepted `options?: OpenOptions` unchanged.

`patch` is `DeepPartial<T>` of the _caller's_ type `T`, not of `Entity<T>`, so
it excludes `id` for free — matching the #4 hand-off ("deep-partial of the
entity type, minus `id`") without a second type.

## Inference: explicit type argument is required

`open("todos.ndjson")` returns `Db<Record<string, unknown>>`. A path is a
string; there is no value carrying the entity shape, so `T` cannot be inferred
and falls back to the default. The file proves this with a `@ts-expect-error`
on `inferred.get("todo_1")?.title` (`unknown` is not `string | undefined`).

**Verdict:** the annotation `open<Todo>(...)` is mandatory. That is not a flaw —
it is the honest cost of "the file on disk does not know your type." It also
makes the untyped default a genuinely useful escape hatch.

## `DeepPartial`: nested patch and `null` removal both type-check

`{ author: { name: "Grace" } }` (recursive merge) and `{ author: null }` (member
removal) both compile. Arrays stay opaque (`tags: string[] | null` — replaced,
never patched into). Error messages are surprisingly readable, because
TypeScript expands the mapped type:

```
error TS2353: Object literal may only specify known properties, and 'nope'
does not exist in type '{ title?: string | null; done?: boolean | null;
tags?: string[] | null; author?: { name?: string | null; } | null; }'.
```

The wrong-value message is equally clear: `Type 'string' is not assignable to
type 'boolean | null'.` So `DeepPartial` does not turn patches into unreadable
type soup; it is a keeper.

## Branded ids: rejected

`type TodoId = string & { readonly __brand: "TodoId" }` works but taxes every
call site: a plain string literal is rejected (`@ts-expect-error` proven), so
ids must be branded at the boundary and re-branded at every `get`/`put`/`patch`.
The spec fixes id content as **opaque** (#3) — a prefix, UUID, and URL are all
legal — so branding adds ceremony and prevents nothing. Rejected as noise.

## Negative checks proven (each `@ts-expect-error` is the assertion)

| Expression                            | Compiler error                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `db.put({ title: "no id" })`          | `TS2345`: `Property 'id' is missing ... but required in type '{ readonly id: string; }'` |
| `db.patch("todo_1", { nope: 1 })`     | `TS2353`: `'nope' does not exist in type '{ title?: ... ; author?: ... }'`               |
| `db.get(1)`                           | `TS2345`: `number` is not assignable to `string`                                         |
| `db.patch("todo_1", { done: "yes" })` | `TS2322`: `string` is not assignable to `boolean \| null`                                |
| `db.get("todo_1")` on branded variant | `TS2345`: `string` is not assignable to `TodoId`                                         |

## Lean

**The generics earn their keep.** Against plain `Record<string, unknown>`, the
type parameter buys compile-time rejection of missing `id`, unknown patch
fields, and wrong value types — all three proven above — at the cost of one
explicit type argument at `open`. `Entity<T>` and `DeepPartial<T>` are short,
dependency-free, and produce readable errors. Keep them; drop branded ids.
