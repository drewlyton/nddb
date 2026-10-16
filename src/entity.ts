import type { PatchAction, PutAction } from "./action.js";

/** A materialized entity. `id` is the only field nddb reserves. */
export type Entity = { readonly id: string } & Record<string, unknown>;

/**
 * Fold one action into the current state of an entity.
 *
 * `put` replaces the entity wholesale. `patch` shallow-merges onto it, and
 * creates the entity if it does not exist yet. The merge is RFC 7386 and
 * recursive — ticket #24; the skeleton stops at a shallow spread.
 */
export const applyAction = (
  entity: Entity | undefined,
  action: PutAction | PatchAction,
): Entity => {
  if (action.op === "put") {
    return { ...action.value, id: action.id };
  }
  return { ...entity, ...action.patch, id: action.id };
};
