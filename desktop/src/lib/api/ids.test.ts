import { describe, expect, it } from "vitest";

import { createIdempotencyKey, createRequestId, normalizeIdempotencyKey, normalizeRequestId } from "./ids.ts";

describe("ids", () => {
  it("生成不含业务数据的不透明请求 ID 和幂等键", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(createRequestId({ cryptoObject: { randomUUID: () => uuid } })).toBe(`desktop-${uuid}`);
    expect(createRequestId()).toMatch(/^desktop-[0-9a-f-]{36}$/);
    expect(createIdempotencyKey()).toMatch(/^desktop-/);
    expect(createIdempotencyKey("crawl", { cryptoObject: null, now: () => 1_000, random: () => 0.5 })).toMatch(
      /^crawl-[a-z0-9]+-[a-z0-9]+$/,
    );
  });

  it("随机源不可用或返回异常值时退回本地标识", () => {
    expect(
      createRequestId({
        cryptoObject: {
          randomUUID: () => {
            throw new Error("blocked");
          },
        },
        now: () => -1,
        random: () => 2,
      }),
    ).toMatch(/^desktop-0-/);
    expect(createRequestId({ cryptoObject: null, now: () => Number.NaN, random: () => Number.NaN })).toBe(
      "desktop-0-0000000",
    );
    expect(() => createIdempotencyKey("invalid prefix")).toThrow("invalid_identifier_prefix");
  });

  it("请求 ID 不合法时返回空串，幂等键不合法时抛错", () => {
    expect(normalizeRequestId(" abc.DEF:1-2_3 ")).toBe("abc.DEF:1-2_3");
    expect(normalizeRequestId("has space")).toBe("");
    expect(normalizeRequestId("x".repeat(129))).toBe("");
    expect(normalizeRequestId(42)).toBe("");
    expect(normalizeIdempotencyKey(" key-0001 ")).toBe("key-0001");
    expect(() => normalizeIdempotencyKey("short")).toThrow("invalid_idempotency_key");
    expect(() => normalizeIdempotencyKey(null)).toThrow("invalid_idempotency_key");
  });
});
