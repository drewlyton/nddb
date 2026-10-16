// THROWAWAY PROTOTYPE for nddb issue #15, "TypeScript type surface".
// Not part of the build, not a proposal, not committed to ship.
// It exists to answer: does a type parameter earn its keep against
// `Record<string, unknown>`, and do the candidate signatures type-check
// under the repo's strict settings?
//
// Settled upstream (see issues #3, #4, #12):
//   - `Entity<T>` carries `id: string`; `id` is required at every write site.
//   - `patch` is RFC 7386 merge patch: nested objects merge, and a `null` at an
//     object-member position removes the member.
//   - The public API is synchronous; nothing returns a Promise.

// ---------------------------------------------------------------------------
// Candidate surface as specified by #15.
// ---------------------------------------------------------------------------

export type Entity<T extends Record<string, unknown>> = { readonly id: string } & T;

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | null }
    : T;

export type Durability = "buffered" | "strict";
export type OpenOptions = {
  readonly durability?: Durability;
  readonly onDamage?: "throw" | "salvage";
};

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
): Db<T> {
  throw new Error("prototype stub");
}

// ---------------------------------------------------------------------------
// Realistic typed call site.
// ---------------------------------------------------------------------------

type Todo = {
  title: string;
  done: boolean;
  tags: string[];
  author: { name: string };
};

const db = open<Todo>("todos.ndjson");

db.put({ id: "todo_1", title: "x", done: false, tags: [], author: { name: "Ada" } });

const t = db.get("todo_1");
const title: string | undefined = t?.title;

// Nested merge patch.
db.patch("todo_1", { done: true });
db.patch("todo_1", { author: { name: "Grace" } });
// `null` at an object-member position removes the member (#4).
db.patch("todo_1", { author: null });
// Arrays are opaque values, replaced wholesale (#4).
db.patch("todo_1", { tags: ["home"] });

// `open<Todo>` is required: a path is just a string, so T defaults to
// `Record<string, unknown>` and there is no field to infer from.
const inferred = open("todos.ndjson");
// @ts-expect-error inferred T is Record<string, unknown>, so `.title` is unknown
const inferredTitle: string | undefined = inferred.get("todo_1")?.title;

// ---------------------------------------------------------------------------
// Untyped call site: the default must keep open escape-hatch usable.
// ---------------------------------------------------------------------------

const any = open("todos.ndjson");
any.put({ id: "a", anything: 1 });

// ---------------------------------------------------------------------------
// Negative checks: each @ts-expect-error is the assertion. If any of these
// lines started compiling, the file would fail with "unused directive".
// ---------------------------------------------------------------------------

// @ts-expect-error missing `id`: Entity<T> requires it (#3)
db.put({ title: "no id" });

// @ts-expect-error unknown field `nope` is not part of DeepPartial<Todo>
db.patch("todo_1", { nope: 1 });

// @ts-expect-error ids are strings; `1` is not
db.get(1);

// Wrong value type, to read how DeepPartial reports nested errors.
// @ts-expect-error `done` is boolean, not string
db.patch("todo_1", { done: "yes" });

// ---------------------------------------------------------------------------
// Branded-id sketch (REJECTED — shown only to record the casting tax).
// Under this variant every id crossing the boundary must be constructed and
// every literal must be cast, while the spec (#3) fixes id content as opaque.
// ---------------------------------------------------------------------------

type TodoId = string & { readonly __brand: "TodoId" };

type BrandedDb<T extends Record<string, unknown>, Id extends string> = {
  get(id: Id): (Entity<T> & { readonly id: Id }) | undefined;
  put(entity: Entity<T> & { readonly id: Id }): void;
  patch(id: Id, patch: DeepPartial<T>): void;
};

declare const branded: BrandedDb<Todo, TodoId>;

// The cast is the tax: the id exists at the boundary as a plain string and has
// to be re-branded on every call.
const todoId = "todo_1" as TodoId;
branded.put({ id: todoId, title: "x", done: false, tags: [], author: { name: "Ada" } });
branded.get(todoId);

// @ts-expect-error a bare string literal is not assignable to TodoId
branded.get("todo_1");
