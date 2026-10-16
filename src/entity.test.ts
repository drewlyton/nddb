import { describe, expect, it } from "vitest";

import type { Action } from "./action.js";
import { applyAction, materialize } from "./entity.js";

const put = (id: string, value: Record<string, unknown>): Action => ({ op: "put", id, value });
const patch = (id: string, patch: Record<string, unknown>): Action => ({ op: "patch", id, patch });
const del = (id: string): Action => ({ op: "delete", id });

describe("materialize", () => {
  it("replaces an entity wholesale on re-put", () => {
    const entities = materialize([
      put("a", { title: "first", done: false }),
      put("a", { title: "second" }),
    ]);

    expect(entities.get("a")).toEqual({ id: "a", title: "second" });
  });

  it("patches recursively, keeping untouched nested siblings", () => {
    const entities = materialize([
      put("a", { profile: { name: "first", tags: ["x"] } }),
      patch("a", { profile: { name: "second" } }),
    ]);

    expect(entities.get("a")).toEqual({ id: "a", profile: { name: "second", tags: ["x"] } });
  });

  it("removes a patched member set to null instead of storing null", () => {
    const entities = materialize([
      put("a", { title: "first", done: false }),
      patch("a", { title: null }),
    ]);

    const entity = entities.get("a");
    expect(entity).toEqual({ id: "a", done: false });
    expect(Object.hasOwn(entity as object, "title")).toBe(false);
  });

  it("creates an entity when patching a missing id", () => {
    const entities = materialize([patch("a", { done: true })]);

    expect(entities.get("a")).toEqual({ id: "a", done: true });
  });

  it("upserts a nested patch on a missing id, removing null members", () => {
    const entities = materialize([patch("a", { profile: { name: "first", note: null } })]);

    expect(entities.get("a")).toEqual({ id: "a", profile: { name: "first" } });
  });

  it("removes the key entirely on delete, with no tombstone", () => {
    const entities = materialize([put("a", { title: "first" }), del("a")]);

    expect(entities.has("a")).toBe(false);
    expect(entities.size).toBe(0);
  });

  it("treats deleting a missing id as a no-op", () => {
    const entities = materialize([put("a", {}), del("b")]);

    expect(entities.has("b")).toBe(false);
    expect([...entities.keys()]).toEqual(["a"]);
  });

  it("resurrects a deleted entity on a later patch", () => {
    const entities = materialize([
      put("a", { title: "first" }),
      del("a"),
      patch("a", { done: true }),
    ]);

    expect(entities.get("a")).toEqual({ id: "a", done: true });
  });

  it("resurrects a deleted entity on a later put", () => {
    const entities = materialize([
      put("a", { title: "first" }),
      del("a"),
      put("a", { title: "again" }),
    ]);

    expect(entities.get("a")).toEqual({ id: "a", title: "again" });
  });

  describe("id stamping", () => {
    it("does not let a put payload id rename the entity", () => {
      const entities = materialize([put("a", { id: "b", title: "first" })]);

      expect([...entities.keys()]).toEqual(["a"]);
      expect(entities.get("a")).toEqual({ id: "a", title: "first" });
      expect(entities.has("b")).toBe(false);
    });

    it("does not let a patch id rename the entity", () => {
      const entities = materialize([put("a", {}), patch("a", { id: "b", done: true })]);

      expect(entities.get("a")).toEqual({ id: "a", done: true });
      expect(entities.has("b")).toBe(false);
    });

    it("does not let a patch null remove the entity's id", () => {
      const entities = materialize([put("a", { title: "first" }), patch("a", { id: null })]);

      expect(entities.get("a")).toEqual({ id: "a", title: "first" });
    });

    it("keeps a nested id as ordinary data", () => {
      const entities = materialize([put("a", { author: { id: "b", name: "Ada" } })]);

      expect(entities.get("a")).toEqual({ id: "a", author: { id: "b", name: "Ada" } });
    });

    it("keeps a __proto__ payload key as ordinary data through put", () => {
      const value = JSON.parse('{"__proto__":{"polluted":true},"title":"first"}') as Record<
        string,
        unknown
      >;

      const entity = materialize([put("a", value)]).get("a") as Record<string, unknown>;

      expect(Object.hasOwn(entity, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(entity)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(entity["__proto__"]).toEqual({ polluted: true });
    });
  });

  describe("iteration order", () => {
    it("keeps a re-put entity in its first-appearance position", () => {
      const entities = materialize([put("a", {}), put("b", {}), put("a", { title: "again" })]);

      expect([...entities.keys()]).toEqual(["a", "b"]);
      expect(entities.get("a")).toEqual({ id: "a", title: "again" });
    });

    it("puts a re-created entity after a hard delete at the end", () => {
      const entities = materialize([put("a", {}), put("b", {}), del("a"), put("a", {})]);

      expect([...entities.keys()]).toEqual(["b", "a"]);
    });
  });

  it("does not mutate the actions or their payloads", () => {
    const actions: readonly Action[] = [
      put("a", { profile: { name: "first", tags: ["x"] } }),
      patch("a", { profile: { name: "second" } }),
      del("a"),
    ];
    const before = structuredClone(actions);

    materialize(actions);

    expect(actions).toEqual(before);
  });

  it("returns a fresh map on every call", () => {
    const actions = [put("a", {})];

    const first = materialize(actions);
    const second = materialize(actions);
    first.delete("a");

    expect(first).not.toBe(second);
    expect(second.has("a")).toBe(true);
  });
});

describe("applyAction", () => {
  it("folds incrementally onto an existing view", () => {
    const entities = materialize([put("a", { title: "first" })]);

    applyAction(entities, patch("a", { done: true }));
    expect(entities.get("a")).toEqual({ id: "a", title: "first", done: true });

    applyAction(entities, put("a", { title: "second" }));
    expect(entities.get("a")).toEqual({ id: "a", title: "second" });

    applyAction(entities, del("a"));
    expect(entities.has("a")).toBe(false);
  });
});
