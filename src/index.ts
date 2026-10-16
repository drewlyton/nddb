/**
 * nddb — a tiny single-file database backed by one NDJSON action log.
 *
 * Entities are materialized by replaying `put`, `patch`, and `delete` actions
 * in order. This is a walking skeleton: the public API is still being designed
 * on the repo's wayfinding map.
 */
export type { Action, DeleteAction, PatchAction, PutAction } from "./action.js";
export { open, type NdjsonDb } from "./db.js";
export { applyAction, type Entity } from "./entity.js";
