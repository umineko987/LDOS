import { readFileSync } from "node:fs";

export function normalizeSourceText(source) {
  if (typeof source !== "string") {
    throw new TypeError("source test text must be a string");
  }
  return source.replace(/\r\n?/gu, "\n");
}

export function readSourceText(path, encoding = "utf8") {
  return normalizeSourceText(readFileSync(path, encoding));
}
