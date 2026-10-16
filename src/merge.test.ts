import { describe, expect, it } from "vitest";

import { merge } from "./merge.js";

type MergeCase = {
  readonly name: string;
  readonly target: unknown;
  readonly patch: unknown;
  readonly result: unknown;
};

/**
 * RFC 7386 Appendix A, all 15 rows, verbatim — including the rows whose
 * target or patch is not an object.
 */
const appendixA: readonly MergeCase[] = [
  {
    name: "A1 replaces a scalar with a scalar",
    target: { a: "b" },
    patch: { a: "c" },
    result: { a: "c" },
  },
  {
    name: "A2 adds a member",
    target: { a: "b" },
    patch: { b: "c" },
    result: { a: "b", b: "c" },
  },
  {
    name: "A3 removes the only member",
    target: { a: "b" },
    patch: { a: null },
    result: {},
  },
  {
    name: "A4 removes one of two members",
    target: { a: "b", b: "c" },
    patch: { a: null },
    result: { b: "c" },
  },
  {
    name: "A5 replaces an array with a scalar",
    target: { a: ["b"] },
    patch: { a: "c" },
    result: { a: "c" },
  },
  {
    name: "A6 replaces a scalar with an array",
    target: { a: "c" },
    patch: { a: ["b"] },
    result: { a: ["b"] },
  },
  {
    name: "A7 merges nested objects and removes a nested member",
    target: { a: { b: "c" } },
    patch: { a: { b: "d", c: null } },
    result: { a: { b: "d" } },
  },
  {
    name: "A8 replaces an array of objects with an array of scalars",
    target: { a: [{ b: "c" }] },
    patch: { a: [1] },
    result: { a: [1] },
  },
  {
    name: "A9 replaces an array target with an array patch",
    target: ["a", "b"],
    patch: ["c", "d"],
    result: ["c", "d"],
  },
  {
    name: "A10 replaces an object target with an array patch",
    target: { a: "b" },
    patch: ["c"],
    result: ["c"],
  },
  {
    name: "A11 replaces an object target with null",
    target: { a: "foo" },
    patch: null,
    result: null,
  },
  {
    name: "A12 replaces an object target with a string",
    target: { a: "foo" },
    patch: "bar",
    result: "bar",
  },
  {
    name: "A13 keeps an existing null target member when adding",
    target: { e: null },
    patch: { a: 1 },
    result: { e: null, a: 1 },
  },
  {
    name: "A14 replaces an array target with an object patch that removes a member",
    target: [1, 2],
    patch: { a: "b", c: null },
    result: { a: "b" },
  },
  {
    name: "A15 removes a deeply nested member, leaving empty objects",
    target: {},
    patch: { a: { bb: { ccc: null } } },
    result: { a: { bb: {} } },
  },
];

describe("merge", () => {
  it.each(appendixA)("matches RFC 7386 Appendix A: $name", ({ target, patch, result }) => {
    expect(merge(target, patch)).toEqual(result);
  });

  it.each(appendixA)("is idempotent: $name", ({ target, patch }) => {
    const once = merge(target, patch);

    expect(merge(once, patch)).toEqual(once);
  });

  it("materializes a patch when the target is undefined", () => {
    expect(merge(undefined, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });

  it("does not mutate its arguments", () => {
    const target = { a: { b: 1, list: [1, 2] }, keep: true };
    const patch = { a: { b: 2 }, list: [3] };
    const targetBefore = structuredClone(target);
    const patchBefore = structuredClone(patch);

    const result = merge(target, patch);

    expect(target).toEqual(targetBefore);
    expect(patch).toEqual(patchBefore);
    expect(result).toEqual({ a: { b: 2, list: [1, 2] }, keep: true, list: [3] });
    expect(result).not.toBe(target);
  });

  it("rebuilds a patched nested object rather than sharing the target's", () => {
    const target = { a: { b: 1 } };
    const patch = { a: { c: 2 } };

    const result = merge(target, patch) as { a: { b: number; c: number } };

    expect(result).toEqual({ a: { b: 1, c: 2 } });
    expect(result).not.toBe(target);
    expect(result.a).not.toBe(target.a);
  });

  it("keeps a top-level __proto__ key as ordinary data", () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;

    const result = merge({}, patch) as Record<string, unknown>;

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps a nested __proto__ key as ordinary data", () => {
    const patch = JSON.parse('{"author":{"__proto__":{"polluted":true}}}') as {
      author: Record<string, unknown>;
    };

    const result = merge({}, patch) as { author: Record<string, unknown> };

    expect(Object.hasOwn(result.author, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.author)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps a constructor.prototype payload from polluting Object.prototype", () => {
    const patch = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as Record<
      string,
      unknown
    >;

    const result = merge({}, patch) as Record<string, unknown>;

    expect(Object.hasOwn(result, "constructor")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps a prototype payload from polluting Object.prototype", () => {
    const patch = JSON.parse('{"prototype":{"polluted":true}}') as Record<string, unknown>;

    const result = merge({}, patch) as Record<string, unknown>;

    expect(Object.hasOwn(result, "prototype")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("round-trips a target's own __proto__ key as data", () => {
    const target = JSON.parse('{"__proto__":{"kept":true}}') as Record<string, unknown>;

    const result = merge(target, {}) as Record<string, unknown>;

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).kept).toBeUndefined();
    expect(result["__proto__"]).toEqual({ kept: true });
  });

  it("keeps a target's own constructor and prototype keys as data", () => {
    const target = JSON.parse(
      '{"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}}',
    ) as Record<string, unknown>;

    const result = merge(target, { unrelated: 1 }) as Record<string, unknown>;

    expect(Object.hasOwn(result, "constructor")).toBe(true);
    expect(Object.hasOwn(result, "prototype")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result["constructor"]).toEqual({ prototype: { polluted: true } });
    expect(result["prototype"]).toEqual({ polluted: true });
  });

  it("keeps a nested __proto__ key reached through recursion as data", () => {
    const target = JSON.parse('{"author":{"__proto__":{"polluted":true}}}') as {
      author: Record<string, unknown>;
    };

    const result = merge(target, { author: { extra: 1 } }) as {
      author: Record<string, unknown>;
    };

    expect(Object.hasOwn(result.author, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.author)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.author["__proto__"]).toEqual({ polluted: true });
  });
});
