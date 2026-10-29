import { describe, expect, it } from "vitest";

import { formatAgo, formatElapsed, formatTimestamp } from "./elapsed.ts";

describe("formatElapsed", () => {
  it("分:秒，超过一小时带小时", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(42.9)).toBe("0:42");
    expect(formatElapsed(723)).toBe("12:03");
    expect(formatElapsed(3723)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("formatAgo", () => {
  it("一分钟内用给定文案，之后用 Intl 相对时间", () => {
    expect(formatAgo(30, "zh-CN", "刚刚")).toBe("刚刚");
    expect(formatAgo(Number.POSITIVE_INFINITY, "en", "just now")).toBe("just now");
    expect(formatAgo(180, "zh-CN", "刚刚")).toBe(new Intl.RelativeTimeFormat("zh-CN", { style: "short" }).format(-3, "minute"));
    expect(formatAgo(7_300, "en", "just now")).toBe(new Intl.RelativeTimeFormat("en", { style: "short" }).format(-2, "hour"));
    expect(formatAgo(200_000, "en", "just now")).toBe(new Intl.RelativeTimeFormat("en", { style: "short" }).format(-2, "day"));
  });
});

describe("formatTimestamp", () => {
  it("无效时间戳返回空串", () => {
    expect(formatTimestamp(null, "zh-CN")).toBe("");
    expect(formatTimestamp(0, "zh-CN")).toBe("");
    expect(formatTimestamp(1_700_000_000, "en")).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "short" }).format(new Date(1_700_000_000_000)),
    );
  });
});
