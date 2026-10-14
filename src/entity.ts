import type { Action } from "./action.js";

/** A materialized entity. `id` is the only field nddb reserves. */
export type Entity = { readonly id: string } & Record<string, unknown>;

/**
 * Fold one action into the current state of an entity.
 *
 * `put` replaces the entity wholesale. `patch` shallow-merges onto it, and
 * creates the entity if it does not exist yet.
 */
export const applyAction = (entity: Entity | undefined, action: Action): Entity => {
  if (action.type === "put") {
    return { ...action.value, id: action.id };
  }
  return { ...entity, ...action.patch, id: action.id };
};
