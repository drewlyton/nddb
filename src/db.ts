import type { Action } from "./action.js";
import { applyAction, type Entity } from "./entity.js";
import { appendAction, readActions } from "./log.js";

/**
 * A handle on one NDJSON action log.
 *
 * The log is the source of truth; `entities` is the derived, in-memory view of
 * it. All operations are synchronous so a prototype can call them anywhere.
 */
export type NdjsonDb = {
  readonly path: string;
  get(id: string): Entity | undefined;
  all(): Entity[];
  put(entity: Entity): void;
  patch(id: string, patch: Record<string, unknown>): void;
};

const foldInto = (entities: Map<string, Entity>, action: Action): void => {
  if (action.op === "delete") {
    entities.delete(action.id);
    return;
  }
  entities.set(action.id, applyAction(entities.get(action.id), action));
};

const materialize = (actions: readonly Action[]): Map<string, Entity> => {
  const entities = new Map<string, Entity>();
  for (const action of actions) {
    foldInto(entities, action);
  }
  return entities;
};

/** Open (or create on first write) the database at `path`. */
export const open = (path: string): NdjsonDb => {
  const entities = materialize(readActions(path));

  const commit = (action: Action): void => {
    appendAction(path, action);
    foldInto(entities, action);
  };

  return {
    path,
    get: (id) => entities.get(id),
    all: () => [...entities.values()],
    put: (entity) => {
      const { id, ...value } = entity;
      commit({ op: "put", id, value });
    },
    patch: (id, patch) => commit({ op: "patch", id, patch }),
  };
};
