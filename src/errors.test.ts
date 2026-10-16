import { describe, expect, it } from "vitest";

import * as errors from "./errors.js";
import {
  actionError,
  closedError,
  damagedError,
  durabilityConflictError,
  nddbError,
  notJsonError,
  unsupportedVersionError,
  type ErrorCode,
} from "./errors.js";
import { FORMAT_VERSION, type LogDamage } from "./log.js";

describe("nddbError", () => {
  it("returns a plain Error with the code attached", () => {
    const error = nddbError("NDDB_CLOSED", "nope");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("nope");
    expect(error.code).toBe("NDDB_CLOSED");
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  });

  it("spreads structured extras onto the error", () => {
    const error = nddbError("NDDB_DAMAGED", "nope", { version: 7 });

    expect(error.version).toBe(7);
    expect(Object.hasOwn(error, "version")).toBe(true);
  });

  it("attaches nothing beyond code when there are no extras", () => {
    const error = nddbError("NDDB_CLOSED", "nope");

    expect(Object.hasOwn(error, "path")).toBe(false);
    expect(Object.hasOwn(error, "damage")).toBe(false);
    expect(Object.hasOwn(error, "version")).toBe(false);
  });
});

describe("actionError", () => {
  it("names the code and the payload path when rejection has one", () => {
    const error = actionError("value-has-null", ["author", "name"]);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("value-has-null");
    expect(error.path).toEqual(["author", "name"]);
    expect(error.message).toBe('invalid put payload: value-has-null at ["author","name"]');
  });

  it("names the code alone when the failure is at the envelope", () => {
    const error = actionError("id-empty");

    expect(error.code).toBe("id-empty");
    expect(error.message).toBe("invalid action: id-empty");
    expect(Object.hasOwn(error, "path")).toBe(false);
  });

  it("names a patch payload for patch codes", () => {
    const error = actionError("patch-null-in-array", [0, "x"]);

    expect(error.code).toBe("patch-null-in-array");
    expect(error.message).toContain("patch payload");
    expect(error.message).toContain('[0,"x"]');
  });
});

describe("notJsonError", () => {
  it("carries the code, the reason, and the payload path", () => {
    const error = notJsonError("bigint", ["n"]);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("not-json");
    expect(error.path).toEqual(["n"]);
    expect(error.message).toContain("bigint");
  });
});

describe("damagedError", () => {
  const damage: LogDamage = { kind: "invalid-json", line: 3, cause: "Unexpected token" };

  it("carries the damage record and the line and kind in the message", () => {
    const error = damagedError(damage);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("NDDB_DAMAGED");
    expect(error.damage).toBe(damage);
    expect(error.message).toContain("line 3");
    expect(error.message).toContain("invalid-json");
  });

  it("carries an invalid-action damage record with its path", () => {
    const invalidAction: LogDamage = {
      kind: "invalid-action",
      line: 9,
      code: "value-not-object",
      path: ["author"],
    };

    expect(damagedError(invalidAction).damage).toEqual(invalidAction);
  });
});

describe("unsupportedVersionError", () => {
  it("names the version and what this build reads up to", () => {
    const error = unsupportedVersionError(2);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("NDDB_UNSUPPORTED_VERSION");
    expect(error.version).toBe(2);
    expect(error.message).toContain("2");
    expect(error.message).toContain(String(FORMAT_VERSION));
    expect(error.message).toContain("this build reads up to");
    expect(Object.hasOwn(error, "damage")).toBe(false);
  });
});

describe("closedError", () => {
  it("is the use-after-close failure", () => {
    const error = closedError();

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("NDDB_CLOSED");
    expect(error.message).toBe("handle is closed");
    expect(Object.hasOwn(error, "path")).toBe(false);
  });
});

describe("durabilityConflictError", () => {
  it("names the path and both durability modes", () => {
    const error = durabilityConflictError("/tmp/x.ndjson", "strict", "buffered");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("NDDB_DURABILITY_CONFLICT");
    expect(error.message).toContain("/tmp/x.ndjson");
    expect(error.message).toContain("buffered");
    expect(error.message).toContain("strict");
  });
});

describe("module surface", () => {
  const factories = [
    "actionError",
    "closedError",
    "damagedError",
    "durabilityConflictError",
    "nddbError",
    "notJsonError",
    "unsupportedVersionError",
  ].sort();

  it("exports exactly the error factories and no other functions", () => {
    const exported = Object.entries(errors as Record<string, unknown>)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();

    expect(exported).toEqual(factories);
  });

  it("exports no classes: no exported function carries a prototype", () => {
    for (const [name, value] of Object.entries(errors as Record<string, unknown>)) {
      if (typeof value === "function") {
        expect(Object.hasOwn(value, "prototype"), name).toBe(false);
      }
    }
  });

  it("types every code the factories can emit as an ErrorCode", () => {
    const codes: ErrorCode[] = [
      actionError("id-empty").code,
      damagedError({ kind: "invalid-json", line: 1, cause: "" }).code,
      unsupportedVersionError(2).code,
      closedError().code,
      durabilityConflictError("/x", "strict", "buffered").code,
      notJsonError("undefined", ["n"]).code,
    ];

    expect(codes).toEqual([
      "id-empty",
      "NDDB_DAMAGED",
      "NDDB_UNSUPPORTED_VERSION",
      "NDDB_CLOSED",
      "NDDB_DURABILITY_CONFLICT",
      "not-json",
    ]);
  });
});
