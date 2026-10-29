// 标签工作室的查询语法。空格分隔的各项之间是“且”：
//
//   1girl            带这个标签（下划线和空格等价，不分大小写，括号转义忽略）
//   -hat             不带这个标签
//   "star (sky)"     带空格或符号的标签用引号；-"star (sky)" 排除
//   cat:character    有这个类别的标签（-cat:meta 排除）
//   untagged         没有标签，或只有触发词
//   is:approved      本阶段已校对；is:pending 是还没校对的
//
// 不认得的类别和 is: 值记成错误，界面上提示；其余各项照常生效。

import { isTagCategory, normalizeTag, tagCategory, TAG_CATEGORIES, type CategoryLookup, type TagCategory } from "./captions.ts";

export type QueryTerm =
  | { readonly kind: "tag"; readonly negate: boolean; readonly value: string }
  | { readonly kind: "category"; readonly negate: boolean; readonly value: TagCategory }
  | { readonly kind: "untagged"; readonly negate: boolean }
  | { readonly kind: "approved"; readonly negate: boolean; readonly value: boolean };

export type QueryError =
  | { readonly kind: "unknown_category"; readonly value: string }
  | { readonly kind: "unknown_state"; readonly value: string };

export interface ParsedQuery {
  readonly terms: readonly QueryTerm[];
  readonly errors: readonly QueryError[];
}

export interface QueryToken {
  readonly negate: boolean;
  readonly quoted: boolean;
  readonly text: string;
  /** 在原查询串里的位置 [start, end)，用来替换或删掉这一项。 */
  readonly start: number;
  readonly end: number;
}

/** 拆成各项：可选的 `-`，然后是引号里的一段（缺右引号时到结尾）或一串非空白。 */
export function tokenizeQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const pattern = /(-?)(?:"([^"]*)"?|([^\s"]+))/g;
  for (const match of query.matchAll(pattern)) {
    const quoted = match[2] !== undefined;
    const text = (quoted ? match[2]! : match[3]!).trim();
    const negate = match[1] === "-";
    // 空引号，或者正在输入、还只有一个 - 的项。
    if (!text || (!quoted && text === "-")) continue;
    tokens.push({ negate, quoted, text, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

export function parseQuery(query: string): ParsedQuery {
  const terms: QueryTerm[] = [];
  const errors: QueryError[] = [];
  for (const { negate, quoted, text } of tokenizeQuery(query)) {
    const lower = text.toLowerCase();
    if (!quoted && lower.startsWith("cat:")) {
      const value = lower.slice(4);
      if (isTagCategory(value)) terms.push({ kind: "category", negate, value });
      else errors.push({ kind: "unknown_category", value });
    } else if (!quoted && lower.startsWith("is:")) {
      const value = lower.slice(3);
      if (value === "approved" || value === "pending") terms.push({ kind: "approved", negate, value: value === "approved" });
      else errors.push({ kind: "unknown_state", value });
    } else if (!quoted && lower === "untagged") {
      terms.push({ kind: "untagged", negate });
    } else {
      const value = normalizeTag(text);
      if (value) terms.push({ kind: "tag", negate, value });
    }
  }
  return { terms, errors };
}

export interface QueryItem {
  /** normalizeTag 过的标签集合（见 {@link queryTags}）。 */
  readonly normalized: ReadonlySet<string>;
  /** 原文标签，类别查表和 untagged 判断用。 */
  readonly tags: readonly string[];
  readonly approved?: boolean;
}

export interface QueryContext {
  readonly triggerWord?: string;
  readonly categoryOf?: CategoryLookup;
}

export function queryTags(tags: readonly string[]): ReadonlySet<string> {
  return new Set(tags.map(normalizeTag));
}

function matchTerm(term: QueryTerm, item: QueryItem, context: QueryContext): boolean {
  switch (term.kind) {
    case "tag":
      return item.normalized.has(term.value);
    case "category": {
      const trigger = context.triggerWord?.trim();
      return item.tags.some((tag) => tag !== trigger && tagCategory(tag, context.categoryOf) === term.value);
    }
    case "untagged": {
      const trigger = context.triggerWord?.trim();
      return item.tags.every((tag) => tag === trigger);
    }
    case "approved":
      return Boolean(item.approved) === term.value;
  }
}

export function matchQuery(query: ParsedQuery, item: QueryItem, context: QueryContext = {}): boolean {
  return query.terms.every((term) => matchTerm(term, item, context) !== term.negate);
}

/** 标签写成查询项：空格换下划线（两者等价）；会被当成语法的（-、cat:、is:、untagged）加引号。 */
export function queryToken(tag: string): string {
  const text = tag.trim().replaceAll('"', "");
  const plain = text.replace(/\s+/g, "_");
  return isSyntax(plain) ? `"${text}"` : plain;
}

function isSyntax(token: string): boolean {
  return token.startsWith("-") || /^(cat|is):/i.test(token) || token.toLowerCase() === "untagged";
}

/** 查询里这个标签是被要求（include）还是被排除（exclude）。 */
export function queryTagState(query: ParsedQuery, tag: string): "include" | "exclude" | null {
  const value = normalizeTag(tag);
  const term = query.terms.find((item) => item.kind === "tag" && item.value === value);
  if (!term) return null;
  return term.negate ? "exclude" : "include";
}

/**
 * 频率表里点一个标签：没有这一项时加上（`negate` 时加排除项）；已经是同一种时去掉；
 * 是相反的那种时换过来。其余各项原样保留。
 */
export function toggleQueryTag(query: string, tag: string, negate = false): string {
  const value = normalizeTag(tag);
  const tokens = tokenizeQuery(query);
  const existing = tokens.find((token) => {
    if (!token.quoted && isSyntax(token.text)) return false;
    return normalizeTag(token.text) === value;
  });
  const kept = tokens.filter((token) => token !== existing).map((token) => query.slice(token.start, token.end));
  if (!existing || existing.negate !== negate) kept.push(`${negate ? "-" : ""}${queryToken(tag)}`);
  return kept.join(" ");
}

export const QUERY_CATEGORIES: readonly TagCategory[] = TAG_CATEGORIES;
