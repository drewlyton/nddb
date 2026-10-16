import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { classifyAction, type Action } from "./action.js";
import { applyAction, materialize, type DeepPartial, type Entity } from "./entity.js";
import {
  actionError,
  closedError,
  damagedError,
  durabilityConflictError,
  notJsonError,
  unsupportedVersionError,
} from "./errors.js";
import { findNonJson, isJsonObject } from "./json.js";
import { readLog, type LogDamage } from "./log.js";
import { createWriter, type Durability, type LogWriter } from "./write.js";

export type { Durability };

/** How a handle opens a log, and how it treats damage found in one. */
export type OpenOptions = {
  readonly durability?: Durability;
  readonly onDamage?: "throw" | "salvage";
};

/** A handle on one NDJSON action log. Every method is synchronous. */
export type Db<T extends Record<string, unknown> = Record<string, unknown>> = {
  readonly path: string;
  get(id: string): Entity<T> | undefined;
  all(): Entity<T>[];
  put(entity: Entity<T>): void;
  patch(id: string, patch: DeepPartial<T>): void;
  delete(id: string): void;
  flush(): void;
  close(): void;
};

/**
 * The one in-process state for a path.
 *
 * One materialized view and one append path per file, because a second writer
 * would hold a stale view (#10). `refs` counts live `open` calls; the entry
 * leaves the cache only when the last one closes.
 */
type Entry = {
  readonly key: string;
  readonly durability: Durability;
  readonly writer: LogWriter;
  readonly entities: Map<string, Entity>;
  readonly damage: LogDamage | undefined;
  refs: number;
  closed: boolean;
  handle: Db<Record<string, unknown>>;
};

const registry = new Map<string, Entry>();

/**
 * Cache key for a path: `realpath` when it resolves, else an absolute resolve.
 *
 * `realpath` first so a symlink and its target share one handle (#10).
 */
const cacheKey = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * Open (or join) the database at `path`.
 *
 * Opening replays the log before returning and never writes: the fd is
 * acquired on the first append (#8, #11). A second `open` on a live path
 * returns the same handle; only a contradicting `durability` is refused.
 */
export const open = <T extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
  options?: OpenOptions,
): Db<T> => {
  const key = cacheKey(path);
  const requested = options?.durability;
  const existing = registry.get(key);

  if (existing !== undefined) {
    if (requested !== undefined && requested !== existing.durability) {
      throw durabilityConflictError(key, requested, existing.durability);
    }
    existing.refs += 1;
    return existing.handle as unknown as Db<T>;
  }

  const read = readLog(key);
  if (read.status === "unsupported-version") {
    // Refusal is not damage, so salvage must not bypass it (#21).
    throw unsupportedVersionError(read.version);
  }
  if (read.status === "damaged" && options?.onDamage !== "salvage") {
    throw damagedError(read.damage);
  }

  const durability: Durability = requested ?? "buffered";
  const entry: Entry = {
    key,
    durability,
    writer: createWriter(key, { durability }),
    entities: materialize(read.actions),
    damage: read.status === "damaged" ? read.damage : undefined,
    refs: 1,
    closed: false,
    handle: undefined as unknown as Db<Record<string, unknown>>,
  };

  const guard = (): void => {
    if (entry.closed) {
      throw closedError();
    }
  };

  const writable = (): void => {
    guard();
    if (entry.damage !== undefined) {
      // Salvage yields a read-only view; repairing it is deliberately absent (#9).
      throw damagedError(entry.damage);
    }
  };

  /** Append first, fold only on success: a failed write leaves the view alone (#16). */
  const commit = (action: Action): void => {
    entry.writer.append(action);
    applyAction(entry.entities, action);
  };

  /** Reject a payload JSON cannot carry, then clone it so the view never aliases the caller. */
  const normalize = (payload: unknown): Record<string, unknown> => {
    const violation = findNonJson(payload);
    if (violation !== undefined) {
      throw notJsonError(violation.reason, violation.path);
    }
    return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  };

  const classifyOrThrow = (input: unknown): Action => {
    const check = classifyAction(input);
    if (!check.ok) {
      throw actionError(check.code, check.path);
    }
    return check.action;
  };

  const handle: Db<T> = {
    path: key,
    get: (id) => {
      guard();
      const entity = entry.entities.get(id);
      return entity === undefined ? undefined : (structuredClone(entity) as Entity<T>);
    },
    all: () => {
      guard();
      return [...entry.entities.values()].map((entity) => structuredClone(entity) as Entity<T>);
    },
    put: (entity) => {
      writable();
      if (!isJsonObject(entity)) {
        throw actionError("not-an-object");
      }
      const { id, ...rest } = entity;
      const value = normalize(rest);
      classifyOrThrow({ op: "put", id, value });
      commit({ op: "put", id, value });
    },
    patch: (id, patch) => {
      writable();
      const value = normalize(patch);
      classifyOrThrow({ op: "patch", id, patch: value });
      commit({ op: "patch", id, patch: value });
    },
    delete: (id) => {
      writable();
      classifyOrThrow({ op: "delete", id });
      commit({ op: "delete", id });
    },
    flush: () => {
      guard();
      entry.writer.flush();
    },
    close: () => {
      if (entry.closed) {
        return;
      }
      entry.refs -= 1;
      if (entry.refs > 0) {
        // The shared handle stays live, but every `close` still honours #8's promise.
        entry.writer.flush();
        return;
      }
      try {
        entry.writer.close();
      } finally {
        entry.closed = true;
        registry.delete(entry.key);
      }
    },
  };

  entry.handle = handle as unknown as Db<Record<string, unknown>>;
  registry.set(key, entry);
  return handle;
};
