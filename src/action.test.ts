import { describe, expect, it } from "vitest";

import {
  classifyAction,
  type Action,
  type ActionErrorCode,
  type ActionPath,
  type PutAction,
} from "./action.js";

type ValidCase = {
  readonly name: string;
  readonly input: unknown;
  readonly action: Action;
};

type InvalidCase = {
  readonly name: string;
  readonly input: unknown;
  readonly code: ActionErrorCode;
  readonly path?: ActionPath;
};

const validCases: readonly ValidCase[] = [
  {
    name: "a complete put",
    input: { op: "put", id: "todo_1", value: { title: "write", done: false } },
    action: { op: "put", id: "todo_1", value: { title: "write", done: false } },
  },
  {
    name: "a put with an empty value",
    input: { op: "put", id: "todo_1", value: {} },
    action: { op: "put", id: "todo_1", value: {} },
  },
  {
    name: "a patch",
    input: { op: "patch", id: "todo_1", patch: { done: true } },
    action: { op: "patch", id: "todo_1", patch: { done: true } },
  },
  {
    name: "a patch removing a member",
    input: { op: "patch", id: "todo_1", patch: { note: null } },
    action: { op: "patch", id: "todo_1", patch: { note: null } },
  },
  {
    name: "a patch removing a nested member",
    input: { op: "patch", id: "todo_1", patch: { a: { b: null } } },
    action: { op: "patch", id: "todo_1", patch: { a: { b: null } } },
  },
  {
    name: "a patch with an opaque array",
    input: { op: "patch", id: "todo_1", patch: { tags: ["a", "b"] } },
    action: { op: "patch", id: "todo_1", patch: { tags: ["a", "b"] } },
  },
  {
    name: "a delete",
    input: { op: "delete", id: "todo_1" },
    action: { op: "delete", id: "todo_1" },
  },
  {
    name: "a whitespace-only id",
    input: { op: "delete", id: " " },
    action: { op: "delete", id: " " },
  },
  {
    name: "an unknown top-level field",
    input: { op: "put", id: "a", value: { x: 1 }, meta: "ignored" },
    action: { op: "put", id: "a", value: { x: 1 } },
  },
  {
    name: "a null in an unknown field",
    input: { op: "delete", id: "a", value: null },
    action: { op: "delete", id: "a" },
  },
  {
    name: "a nested null in an unknown field",
    input: { op: "put", id: "a", value: {}, patch: { x: null } },
    action: { op: "put", id: "a", value: {} },
  },
];

const invalidCases: readonly InvalidCase[] = [
  { name: "null", input: null, code: "not-an-object" },
  { name: "an array", input: [], code: "not-an-object" },
  { name: "a string", input: "x", code: "not-an-object" },
  { name: "a number", input: 1, code: "not-an-object" },
  { name: "a boolean", input: true, code: "not-an-object" },
  { name: "undefined", input: undefined, code: "not-an-object" },

  { name: "an empty object", input: {}, code: "op-missing" },
  { name: "an object without an op", input: { id: "a", value: {} }, code: "op-missing" },

  { name: "an unknown op", input: { op: "nope", id: "a" }, code: "op-unknown" },
  { name: "an uppercase op", input: { op: "PUT", id: "a", value: {} }, code: "op-unknown" },
  { name: "a non-string op", input: { op: 1, id: "a" }, code: "op-unknown" },

  { name: "a missing id", input: { op: "delete" }, code: "id-missing" },
  { name: "a non-string id", input: { op: "delete", id: 1 }, code: "id-not-string" },
  { name: "an empty id", input: { op: "delete", id: "" }, code: "id-empty" },

  { name: "a missing put value", input: { op: "put", id: "a" }, code: "value-missing" },
  {
    name: "a null put value",
    input: { op: "put", id: "a", value: null },
    code: "value-not-object",
  },
  {
    name: "an array put value",
    input: { op: "put", id: "a", value: [] },
    code: "value-not-object",
  },
  { name: "a scalar put value", input: { op: "put", id: "a", value: 1 }, code: "value-not-object" },

  {
    name: "a null put member",
    input: { op: "put", id: "a", value: { x: null } },
    code: "value-has-null",
    path: ["x"],
  },
  {
    name: "a null in a put array",
    input: { op: "put", id: "a", value: { x: [1, null] } },
    code: "value-has-null",
    path: ["x", 1],
  },
  {
    name: "a null deep in a put array of objects",
    input: { op: "put", id: "a", value: { x: [{ y: null }] } },
    code: "value-has-null",
    path: ["x", 0, "y"],
  },

  { name: "a missing patch", input: { op: "patch", id: "a" }, code: "patch-missing" },
  { name: "a null patch", input: { op: "patch", id: "a", patch: null }, code: "patch-not-object" },
  { name: "an array patch", input: { op: "patch", id: "a", patch: [] }, code: "patch-not-object" },

  {
    name: "a null in a patch array",
    input: { op: "patch", id: "a", patch: { tags: [null] } },
    code: "patch-null-in-array",
    path: ["tags", 0],
  },
  {
    name: "a null in a patch object inside an array",
    input: { op: "patch", id: "a", patch: { tags: [{ x: null }] } },
    code: "patch-null-in-array",
    path: ["tags", 0, "x"],
  },
  {
    name: "a null deep in a patch array",
    input: { op: "patch", id: "a", patch: { a: { b: [1, null] } } },
    code: "patch-null-in-array",
    path: ["a", "b", 1],
  },
];

describe("classifyAction", () => {
  it.each(validCases)("accepts $name", ({ input, action }) => {
    expect(classifyAction(input)).toEqual({ ok: true, action });
  });

  it.each(invalidCases)("rejects $name with $code", ({ input, code, path }) => {
    const result = classifyAction(input);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe(code);
    if (path === undefined) {
      expect(result.path).toBeUndefined();
    } else {
      expect(result.path).toEqual(path);
    }
  });

  it("returns the caller's payload by reference", () => {
    const value = { title: "write" };
    const result = classifyAction({ op: "put", id: "a", value });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect((result.action as PutAction).value).toBe(value);
  });

  it("treats a top-level __proto__ key as ordinary data", () => {
    const input = JSON.parse('{"op":"put","id":"a","value":{"__proto__":{"polluted":true}}}');

    const result = classifyAction(input);

    expect(result.ok).toBe(true);
    if (!result.ok || result.action.op !== "put") {
      return;
    }
    expect(Object.hasOwn(result.action.value, "__proto__")).toBe(true);
    expect(Object.entries(result.action.value)).toEqual([["__proto__", { polluted: true }]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("treats a nested __proto__ key as ordinary data", () => {
    const input = JSON.parse(
      '{"op":"put","id":"a","value":{"author":{"__proto__":{"polluted":true}}}}',
    );

    const result = classifyAction(input);

    expect(result.ok).toBe(true);
    if (!result.ok || result.action.op !== "put") {
      return;
    }
    const author = result.action.value.author as Record<string, unknown>;
    expect(Object.hasOwn(author, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
