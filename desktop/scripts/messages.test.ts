import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import settings from "../project.inlang/settings.json" with { type: "json" };

// 约定见 messages/README.md：键名 `<area>_<name>`，snake_case，按字母序排列，各语言键集合一致。
const KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function load(locale: string): Record<string, string> {
  const raw = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
  const { $schema: _schema, ...messages } = raw;
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== "string") throw new Error(`${locale}.json: ${key} 不是字符串`);
  }
  return messages as Record<string, string>;
}

const base = settings.baseLocale;
const catalogs = Object.fromEntries(settings.locales.map((locale) => [locale, load(locale)]));

describe("messages", () => {
  it.each(settings.locales)("%s 的键名符合 <area>_<name> snake_case", (locale) => {
    const bad = Object.keys(catalogs[locale]!).filter((key) => !KEY.test(key));
    expect(bad).toEqual([]);
  });

  it.each(settings.locales)("%s 的键按字母序排列", (locale) => {
    const keys = Object.keys(catalogs[locale]!);
    expect(keys).toEqual([...keys].sort());
  });

  it.each(settings.locales.filter((locale) => locale !== base))("%s 与基准语言的键集合一致", (locale) => {
    expect(Object.keys(catalogs[locale]!)).toEqual(Object.keys(catalogs[base]!));
  });

  it.each(settings.locales)("%s 没有空文案", (locale) => {
    const empty = Object.entries(catalogs[locale]!).filter(([, value]) => value.trim() === "");
    expect(empty).toEqual([]);
  });

  it("占位符在各语言之间一致", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const mismatched = Object.keys(catalogs[base]!).filter((key) =>
      settings.locales.some(
        (locale) => placeholders(catalogs[locale]![key]!).join() !== placeholders(catalogs[base]![key]!).join(),
      ),
    );
    expect(mismatched).toEqual([]);
  });
});
