import type { Action } from "./action.js";
import { merge } from "./merge.js";

/**
 * A materialized entity: the caller's fields plus the reserved `id`.
 *
 * The parameter is explicit at `open<T>`; the default keeps the schemaless
 * case usable without annotating every call site.
 */
export type Entity<T extends Record<string, unknown> = Record<string, unknown>> = {
  readonly id: string;
} & T;

/**
 * A patch over `T`'s fields: nested objects recurse, arrays stay opaque, and a
 * `null` at a member position removes that member (#4).
 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | null }
    : T;

/**
 * Fold one action into a materialised view, in place.
 *
 * `put` replaces the entity wholesale. `patch` is an RFC 7386 merge onto the
 * existing entity, upserting when the id is absent. `delete` removes the key
 * entirely — hard delete, no tombstone, and a no-op for a missing id.
 *
 * A patch cannot rename: the envelope's `id` is stamped after the payload, so
 * a top-level payload `id` is overwritten and a patch that nulls `id` removes
 * a member only to have the envelope restore it. A nested `id` is data.
 *
 * `Map` supplies iteration order: insertion order, so a re-`put` of a live key
 * keeps its original position. Whether that is a public promise is #13's call.
 */
export const applyAction = (entities: Map<string, Entity>, action: Action): void => {
  if (action.op === "delete") {
    entities.delete(action.id);
    return;
  }

  if (action.op === "put") {
    entities.set(action.id, { ...action.value, id: action.id });
    return;
  }

  // The grammar admits only JSON-object patches, so an object goes in and an
  // object comes back out; `merge`'s `unknown` is widened by that guarantee.
  const patched = merge(entities.get(action.id), action.patch) as Record<string, unknown>;
  entities.set(action.id, { ...patched, id: action.id });
};

/** Fold a whole log into a fresh materialised view. */
export const materialize = (actions: readonly Action[]): Map<string, Entity> => {
  const entities = new Map<string, Entity>();
  for (const action of actions) {
    applyAction(entities, action);
  }
  return entities;
};
