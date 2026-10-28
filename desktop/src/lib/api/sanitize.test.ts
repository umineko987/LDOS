import { describe, expect, it } from "vitest";

import { boundedCount, boundedString, isPlainRecord, ownRecord, ownValue, sanitizeErrorDetails } from "./sanitize.ts";

describe("sanitize", () => {
  it("isPlainRecord 只认普通对象和无原型对象", () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(new Date())).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord("x")).toBe(false);
  });

  it("ownValue 不触发 getter，不读继承属性", () => {
    let touched = false;
    const record = Object.create({ inherited: 1 }) as Record<string, unknown>;
    Object.defineProperty(record, "getter", {
      enumerable: true,
      get() {
        touched = true;
        return 1;
      },
    });
    record.own = 2;
    expect(ownValue(record, "own")).toBe(2);
    expect(ownValue(record, "getter")).toBeUndefined();
    expect(ownValue(record, "inherited")).toBeUndefined();
    expect(ownValue(null, "own")).toBeUndefined();
    expect(touched).toBe(false);
    expect(ownRecord({ nested: { a: 1 } }, "nested")).toEqual({ a: 1 });
    expect(ownRecord({ nested: [1] }, "nested")).toBeNull();
  });

  it("boundedString 和 boundedCount 截断并给兜底值", () => {
    expect(boundedString("  abc  ", "x")).toBe("abc");
    expect(boundedString("   ", "x")).toBe("x");
    expect(boundedString(1, "x")).toBe("x");
    expect(boundedString("abcdef", "x", 3)).toBe("abc");
    expect(boundedCount(5)).toBe(5);
    expect(boundedCount(5, 3)).toBe(3);
    expect(boundedCount(-1)).toBe(0);
    expect(boundedCount(1.5)).toBe(0);
    expect(boundedCount("5")).toBe(0);
  });

  it("sanitizeErrorDetails 去掉敏感键、不安全键、访问器和过深的数据", () => {
    const details: Record<string, unknown> = {
      field: "name",
      count: 3,
      infinite: Number.POSITIVE_INFINITY,
      ok: true,
      empty: null,
      long: "x".repeat(600),
      items: Array.from({ length: 30 }, (_, index) => index),
      nested: { a: { b: { c: { d: 1 } } } },
      date: new Date(0),
      access_token: "never",
      output_path: "/home/user",
      "bad key": 1,
      fn: () => 1,
    };
    Object.defineProperty(details, "getter", { enumerable: true, get: () => "never" });
    Object.defineProperty(details, "__proto__", { enumerable: true, value: { polluted: true } });

    const result = sanitizeErrorDetails(details) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect({ ...result }).toEqual({
      field: "name",
      count: 3,
      infinite: null,
      ok: true,
      empty: null,
      long: "x".repeat(500),
      items: Array.from({ length: 20 }, (_, index) => index),
      nested: { a: { b: { c: null } } },
      date: null,
      fn: null,
    });
    expect(sanitizeErrorDetails(undefined)).toBeNull();
  });
});
