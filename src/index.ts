/**
 * nddb — a tiny single-file database backed by one NDJSON action log.
 *
 * Entities are materialized by replaying `put`, `patch`, and `delete` actions
 * in order.
 */
export type { Action, DeleteAction, PatchAction, PutAction } from "./action.js";
export { open, type Db, type Durability, type OpenOptions } from "./db.js";
export type { DeepPartial, Entity } from "./entity.js";
export type { ErrorCode, NdDbError } from "./errors.js";
