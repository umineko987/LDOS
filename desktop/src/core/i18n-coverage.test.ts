import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { parse } from "svelte/compiler";
import { describe, expect, it } from "vitest";

import { translateUiText } from "./i18n";

const HAN = /[\u3400-\u9fff]/u;
const SOURCE_ROOT = join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(svelte|ts)$/u.test(entry.name)) return [];
    if (entry.name.endsWith(".test.ts") || entry.name.startsWith("i18n.")) return [];
    return [path];
  });
}

function collectSvelteText(source: string): string[] {
  const root = parse(source, { modern: true });
  const values: string[] = [];
  const visited = new WeakSet<object>();

  function visit(node: unknown): void {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    const record = node as Record<string, unknown>;

    if (record.type === "Text" && typeof record.data === "string") values.push(record.data);
    if (record.type === "Literal" && typeof record.value === "string") values.push(record.value);
    if (record.type === "TemplateLiteral" && Array.isArray(record.quasis)) {
      const quasis = record.quasis as Array<{ value?: { cooked?: string } }>;
      values.push(quasis.map((quasi, index) => `${quasi.value?.cooked ?? ""}${index < quasis.length - 1 ? "X" : ""}`).join(""));
    }

    for (const value of Object.values(record)) visit(value);
  }

  visit(root.fragment);
  visit(root.instance);
  visit(root.module);
  return values;
}

function collectTypeScriptText(source: string, file: string): string[] {
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const values: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) values.push(node.text);
    if (ts.isTemplateExpression(node)) {
      values.push(`${node.head.text}${node.templateSpans.map((span) => `X${span.literal.text}`).join("")}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(root);
  return values;
}

describe("English UI catalog", () => {
  it("covers every Chinese production UI string", () => {
    const untranslated = sourceFiles(SOURCE_ROOT).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const values = file.endsWith(".svelte") ? collectSvelteText(source) : collectTypeScriptText(source, file);
      return Array.from(new Set(values))
        .filter((value) => HAN.test(value))
        .map((value) => ({ file: relative(SOURCE_ROOT, file), value, translated: translateUiText(value, "en") }))
        .filter(({ translated }) => HAN.test(translated));
    });

    expect(untranslated).toEqual([]);
  });
});
