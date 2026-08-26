const SITE_IDS = ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"] as const;
const PROXY_MODES = ["direct", "prefer", "required"] as const;
const SOURCE_STATUSES = ["succeeded", "partial", "failed"] as const;
const AUTH_STATES = ["ready", "authorized", "authorizing", "required", "public"] as const;
const FILTER_MODES = ["include", "exclude"] as const;
const EH_NAMESPACES = new Set([
  "artist", "character", "cosplayer", "female", "group", "language", "location",
  "male", "mixed", "other", "parody", "reclass", "temp", "unknown",
]);
const EH_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  a: "artist", artist: "artist", c: "character", char: "character", character: "character",
  cos: "cosplayer", cosplayer: "cosplayer", f: "female", female: "female",
  g: "group", circle: "group", group: "group", l: "language", lang: "language",
  language: "language", loc: "location", location: "location", m: "male", male: "male",
  x: "mixed", mixed: "mixed", o: "other", other: "other", p: "parody",
  series: "parody", parody: "parody", r: "reclass", reclass: "reclass", temp: "temp",
});
const EVIDENCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  site_search_work_evidence: "有站内作品结果",
  account_name_exact_match: "账号身份精确匹配",
  account_identity_unverified: "账号身份待核对",
  danbooru_artist_directory_match: "Danbooru 画师目录匹配",
  danbooru_artist_directory_alias_match: "Danbooru 画师别名待核对",
  artist_tag_exact_match: "画师标签精确匹配",
  character_tag_exact_match: "角色标签精确匹配",
  keyword_gallery_search_only: "仅关键词画廊命中",
  keyword_gallery_search: "站内关键词画廊结果",
  keyword_creator_search: "站内画师目录命中",
  danbooru_artist_url: "Danbooru 人工维护主页",
  danbooru_alias_search: "Danbooru 别名扩搜命中",
  danbooru_alias_name_match: "Danbooru 别名精确匹配",
});

export const CRAWL_SITE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "danbooru", label: "Danbooru" }),
  Object.freeze({ id: "twitter", label: "X / Twitter · Danbooru 画师目录关联账户" }),
  Object.freeze({ id: "pixiv", label: "Pixiv · Danbooru 画师目录关联账户" }),
  Object.freeze({ id: "exhentai", label: "EH" }),
  Object.freeze({ id: "pawchive", label: "Pawchive" }),
] as const);
export const CRAWL_PAGE_LIMITS = Object.freeze({ search: 200, addresses: 500, tasks: 100_000 });
export const AUTOCOMPLETE_DELAY_MS = 300;

export type CrawlSiteId = typeof SITE_IDS[number];
export type CrawlProxyMode = typeof PROXY_MODES[number];
export type CrawlFilterMode = typeof FILTER_MODES[number];
export type CrawlSourceKey = `source:${CrawlSiteId}`;
export type CrawlCandidateKey = `candidate:${CrawlSiteId}:${string}`;
export type CrawlPhase = "initial" | "loading" | "settled" | "error" | "recovery";
export type CrawlBusy = "" | "search" | "crawl";

export interface CrawlTag {
  readonly key: string;
  readonly namespace: string;
  readonly value: string;
}

export interface CrawlTagFacet {
  readonly namespace: string;
  readonly label: string;
  readonly galleryCount: number;
  readonly tags: readonly Readonly<{ key: string; value: string; count: number }>[];
}

export interface CrawlCandidate {
  readonly key: CrawlCandidateKey;
  readonly sourceKey: CrawlSourceKey;
  readonly site: CrawlSiteId;
  readonly weak: boolean;
  readonly selected: boolean;
  readonly submitId: string;
  readonly label: string;
  readonly addressType: string;
  readonly displayEndpoint: string;
  readonly confidence: "verified" | "site_search" | "weak";
  readonly origin: string;
  readonly mediaCount: number;
  readonly relatedProfileCount: number;
  readonly evidence: readonly string[];
  readonly tags: readonly CrawlTag[];
  readonly thumbnailUrl: string;
}

export interface CrawlSource {
  readonly key: CrawlSourceKey;
  readonly site: CrawlSiteId;
  readonly label: string;
  readonly status: typeof SOURCE_STATUSES[number];
  readonly evidenceCount: number;
  readonly previewCount: number;
  readonly attempts: number;
  readonly aliases: readonly string[];
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly enrichmentIssueCount: number;
  readonly auth: Readonly<{ known: boolean; authorized: boolean; state: string }>;
  readonly tagFacets: readonly CrawlTagFacet[];
}

export interface CrawlProfile {
  readonly key: string;
  readonly artist: string;
  readonly platform: string;
  readonly host: string;
  readonly url: string;
}

export interface CrawlSnapshot {
  readonly sources: Readonly<Record<CrawlSourceKey, CrawlSource>>;
  readonly sourceOrder: readonly CrawlSourceKey[];
  readonly candidates: Readonly<Record<CrawlCandidateKey, CrawlCandidate>>;
  readonly candidateOrder: Readonly<Record<CrawlSourceKey, readonly CrawlCandidateKey[]>>;
  readonly relatedProfiles: readonly CrawlProfile[];
  readonly addressCount: number;
  readonly weakEvidenceCount: number;
  readonly showWeakEvidence: boolean;
  readonly ehTagFilter: Readonly<Record<string, CrawlFilterMode>>;
}

export interface CrawlOperation {
  readonly site: CrawlSiteId;
  readonly url: string;
  readonly id: string;
  readonly label: string;
  readonly address_type: string;
}

export interface CrawlSearchProjection {
  readonly snapshot: CrawlSnapshot;
  readonly operations: ReadonlyMap<CrawlCandidateKey, CrawlOperation>;
}

export interface CrawlSuggestion {
  readonly key: string;
  readonly value: string;
  readonly label: string;
  readonly category: "artist" | "character" | "copyright" | "general" | "meta";
  readonly antecedent: string;
  readonly postCount: number;
}

export interface CrawlValidation {
  readonly valid: boolean;
  readonly field: string;
  readonly reason: string;
}

export interface SearchDraft {
  readonly keyword: string;
  readonly sites: readonly CrawlSiteId[];
  readonly limit: number;
  readonly proxyMode: CrawlProxyMode;
  readonly sourceProxyModes: Readonly<Partial<Record<CrawlSiteId, CrawlProxyMode | "">>>;
}

export interface CrawlDraft {
  readonly concurrency: number;
  readonly maxTasks: number;
  readonly proxyMode: CrawlProxyMode;
  readonly outputDir: string;
  readonly outputDirInvalid?: boolean;
  readonly sourceProxyModes: Readonly<Partial<Record<CrawlSiteId, CrawlProxyMode | "">>>;
  readonly ehDownload: Readonly<{ image_mode: "original" | "resample"; gp_policy: "stop" | "resized" }>;
}

export interface CrawlErrorPresentation {
  readonly code: string;
  readonly requestId: string;
  readonly targetApp: "vault" | "proxy" | "diagnostics";
  readonly title: string;
  readonly message: string;
  readonly nextStep: string;
}

interface SafeRecord {
  readonly descriptors: PropertyDescriptorMap;
}

function safeRecord(value: unknown): SafeRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return { descriptors: Object.getOwnPropertyDescriptors(value) };
  } catch {
    return null;
  }
}

function own(record: SafeRecord, key: string): unknown {
  const descriptor = record.descriptors[key];
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function safeText(value: unknown, fallback = "", maximum = 180): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "[地址已隐藏]")
    .replace(/\b(token|cookie|password|secret|authorization|oauth|session)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/(^|[\s(])(?:[A-Za-z]:[\\/]|\/)[^\s,;，；)]+/g, "$1[路径已隐藏]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function safeIdentifier(value: unknown, maximum = 128): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) && text.length <= maximum ? text : "";
}

function boundedInteger(value: unknown, maximum = 1_000_000_000): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= maximum ? number : 0;
}

function safeOperationalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 4 || value.length > 8_192 || /[\u0000-\u0020\u007f]/.test(value)) return "";
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password
      ? parsed.href
      : "";
  } catch {
    return "";
  }
}

function opaqueUrlKey(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function sourceKey(site: CrawlSiteId): CrawlSourceKey {
  return `source:${site}`;
}

function candidateKey(site: CrawlSiteId, id: string, url: string): CrawlCandidateKey {
  return `candidate:${site}:${id || opaqueUrlKey(url)}`;
}

function displayEndpoint(value: string, site: CrawlSiteId, addressType: string): string {
  const parsed = new URL(value);
  const host = parsed.hostname.replace(/^www\./, "");
  if (site === "exhentai") {
    const match = parsed.pathname.match(/^\/g\/(\d+)\//);
    return match ? `${host} · 画廊 ${match[1]} · 访问令牌已隐藏` : `${host} · EH 画廊`;
  }
  return `${host} · ${safeText(addressType, "来源地址", 50)}`;
}

function safeThumbnail(value: unknown, site: CrawlSiteId): string {
  if (site !== "exhentai") return "";
  const url = safeOperationalUrl(value);
  if (!url) return "";
  const parsed = new URL(url);
  if (!/(^|\.)(ehgt\.org|ehgt\.com|e-hentai\.org|exhentai\.org)$/.test(parsed.hostname.toLowerCase())) return "";
  if (parsed.search || parsed.hash || /(?:token|secret|auth|session)/i.test(parsed.pathname)) return "";
  return parsed.href;
}

function safeExternalProfileUrl(value: unknown): string {
  const url = safeOperationalUrl(value);
  if (!url) return "";
  const parsed = new URL(url);
  if (parsed.search || parsed.hash || /(?:token|secret|oauth|session)/i.test(parsed.pathname)) return "";
  return parsed.href;
}

export function parseEhTag(value: unknown): CrawlTag | null {
  const text = safeText(value, "", 180);
  if (!text) return null;
  const separator = text.indexOf(":");
  const namespace = separator > 0
    ? EH_ALIASES[text.slice(0, separator).trim().toLowerCase()] ?? "unknown"
    : "temp";
  const tagValue = (separator > 0 ? text.slice(separator + 1) : text).trim();
  if (!tagValue) return null;
  return Object.freeze({ namespace, value: tagValue, key: `${namespace}:${tagValue.toLowerCase()}` });
}

function sanitizeTags(value: unknown): readonly CrawlTag[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const tags: CrawlTag[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 160)) {
    const tag = parseEhTag(item);
    if (!tag || seen.has(tag.key)) continue;
    seen.add(tag.key);
    tags.push(tag);
  }
  return Object.freeze(tags);
}

function sanitizeFacets(value: unknown): readonly CrawlTagFacet[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const facets: CrawlTagFacet[] = [];
  for (const rawFacet of value.slice(0, 32)) {
    const facet = safeRecord(rawFacet);
    if (!facet) continue;
    const rawNamespace = String(own(facet, "namespace") ?? "");
    const namespace = EH_NAMESPACES.has(rawNamespace) ? rawNamespace : "unknown";
    const tags: Array<Readonly<{ key: string; value: string; count: number }>> = [];
    const rawTags = own(facet, "tags");
    if (Array.isArray(rawTags)) {
      for (const rawTag of rawTags.slice(0, 160)) {
        const item = safeRecord(rawTag);
        if (!item) continue;
        const value = String(own(item, "tag") ?? "");
        const parsed = parseEhTag(value.includes(":") ? value : `${namespace}:${value}`);
        if (!parsed) continue;
        tags.push(Object.freeze({ key: parsed.key, value: parsed.value, count: boundedInteger(own(item, "count")) }));
      }
    }
    if (!tags.length) continue;
    facets.push(Object.freeze({
      namespace,
      label: safeText(own(facet, "label"), namespace, 80),
      galleryCount: boundedInteger(own(facet, "gallery_count")),
      tags: Object.freeze(tags),
    }));
  }
  return Object.freeze(facets);
}

function sanitizeAuth(value: unknown): CrawlSource["auth"] {
  const record = safeRecord(value);
  if (!record) return Object.freeze({ known: false, authorized: false, state: "unknown" });
  const rawState = own(record, "state");
  const state = typeof rawState === "string" && (AUTH_STATES as readonly string[]).includes(rawState)
    ? rawState
    : "unknown";
  return Object.freeze({ known: state !== "unknown", authorized: own(record, "authorized") === true, state });
}

function sanitizeCandidate(
  value: unknown,
  site: CrawlSiteId,
  source: CrawlSourceKey,
  weak: boolean,
): { readonly candidate: CrawlCandidate; readonly operation: CrawlOperation } | null {
  const record = safeRecord(value);
  if (!record) return null;
  const url = safeOperationalUrl(own(record, "url"));
  if (!url) return null;
  const submitId = safeIdentifier(own(record, "id"));
  const key = candidateKey(site, submitId, url);
  const addressType = safeText(own(record, "address_type"), "来源地址", 64);
  const label = safeText(
    own(record, "label") ?? own(record, "tag") ?? own(record, "title") ?? own(record, "id"),
    "未命名来源",
    180,
  );
  const reasons = own(record, "evidence_reasons");
  const evidence = Array.isArray(reasons)
    ? reasons.slice(0, 12)
      .map((reason) => typeof reason === "string" ? EVIDENCE_LABELS[reason] : undefined)
      .filter((reason): reason is string => Boolean(reason))
    : [];
  const metadata = safeRecord(own(record, "metadata"));
  const relatedProfiles = own(record, "related_profiles");
  const confidence = weak ? "weak" : own(record, "confidence") === "verified" ? "verified" : "site_search";
  return Object.freeze({
    candidate: Object.freeze({
      key,
      sourceKey: source,
      site,
      weak,
      selected: false,
      submitId,
      label,
      addressType,
      displayEndpoint: displayEndpoint(url, site, addressType),
      confidence,
      origin: safeText(own(record, "origin"), "", 64),
      mediaCount: boundedInteger(own(record, "media_count")),
      relatedProfileCount: Array.isArray(relatedProfiles)
        ? Math.min(relatedProfiles.length, 1_000)
        : boundedInteger(own(record, "related_profile_count"), 1_000),
      evidence: Object.freeze(evidence),
      tags: sanitizeTags(metadata ? own(metadata, "tags") : undefined),
      thumbnailUrl: safeThumbnail(own(record, "thumbnail_url"), site),
    }),
    operation: Object.freeze({ site, url, id: submitId, label, address_type: addressType }),
  });
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function emptyCrawlSnapshot(): CrawlSnapshot {
  return Object.freeze({
    sources: Object.freeze(emptyRecord<CrawlSource>()) as Readonly<Record<CrawlSourceKey, CrawlSource>>,
    sourceOrder: Object.freeze([]) as readonly CrawlSourceKey[],
    candidates: Object.freeze(emptyRecord<CrawlCandidate>()) as Readonly<Record<CrawlCandidateKey, CrawlCandidate>>,
    candidateOrder: Object.freeze(emptyRecord<readonly CrawlCandidateKey[]>()) as Readonly<Record<CrawlSourceKey, readonly CrawlCandidateKey[]>>,
    relatedProfiles: Object.freeze([]),
    addressCount: 0,
    weakEvidenceCount: 0,
    showWeakEvidence: false,
    ehTagFilter: Object.freeze(emptyRecord<CrawlFilterMode>()),
  });
}

export function sanitizeCrawlSearchResponse(value: unknown): CrawlSearchProjection {
  const root = safeRecord(value);
  const rawSources = root ? own(root, "sources") : null;
  if (!Array.isArray(rawSources)) throw new TypeError("invalid_crawl_search_response");

  const sources = emptyRecord<CrawlSource>();
  const candidates = emptyRecord<CrawlCandidate>();
  const candidateOrder = emptyRecord<readonly CrawlCandidateKey[]>();
  const sourceOrder: CrawlSourceKey[] = [];
  const operations = new Map<CrawlCandidateKey, CrawlOperation>();
  const seenSites = new Set<CrawlSiteId>();
  const seenUrls = new Set<string>();
  let addressCount = 0;
  let weakEvidenceCount = 0;

  for (const rawSource of rawSources.slice(0, SITE_IDS.length)) {
    const sourceRecord = safeRecord(rawSource);
    if (!sourceRecord) continue;
    const rawSite = String(own(sourceRecord, "site") ?? "").trim().toLowerCase();
    if (!(SITE_IDS as readonly string[]).includes(rawSite) || seenSites.has(rawSite as CrawlSiteId)) continue;
    const site = rawSite as CrawlSiteId;
    seenSites.add(site);
    const key = sourceKey(site);
    const ids: CrawlCandidateKey[] = [];
    const addCandidates = (items: unknown, weak: boolean): void => {
      if (!Array.isArray(items)) return;
      for (const raw of items.slice(0, CRAWL_PAGE_LIMITS.addresses)) {
        const projected = sanitizeCandidate(raw, site, key, weak);
        if (!projected || seenUrls.has(projected.operation.url)) continue;
        let candidate = projected.candidate;
        let candidateId = candidate.key;
        if (Object.hasOwn(candidates, candidateId)) {
          candidateId = candidateKey(site, "", projected.operation.url);
          candidate = Object.freeze({ ...candidate, key: candidateId });
        }
        if (Object.hasOwn(candidates, candidateId)) continue;
        seenUrls.add(projected.operation.url);
        candidates[candidateId] = candidate;
        operations.set(candidateId, projected.operation);
        ids.push(candidateId);
        if (weak) weakEvidenceCount += 1;
        else addressCount += 1;
      }
    };
    addCandidates(own(sourceRecord, "addresses"), false);
    addCandidates(own(sourceRecord, "weak_evidence"), true);
    const rawStatus = own(sourceRecord, "status");
    const status = typeof rawStatus === "string" && (SOURCE_STATUSES as readonly string[]).includes(rawStatus)
      ? rawStatus as CrawlSource["status"]
      : "failed";
    const rawAliases = own(sourceRecord, "alias_keywords");
    const rawError = safeRecord(own(sourceRecord, "error"));
    const enrichmentErrors = own(sourceRecord, "enrichment_errors");
    sources[key] = Object.freeze({
      key,
      site,
      label: CRAWL_SITE_DEFINITIONS.find(({ id }) => id === site)?.label ?? site,
      status,
      evidenceCount: boundedInteger(own(sourceRecord, "evidence_count")),
      previewCount: boundedInteger(own(sourceRecord, "preview_count")),
      attempts: boundedInteger(own(sourceRecord, "attempts"), 1_000_000),
      aliases: Object.freeze(Array.isArray(rawAliases)
        ? rawAliases.slice(0, 16).map((item) => safeText(item, "", 80)).filter(Boolean)
        : []),
      errorCode: safeIdentifier(rawError ? own(rawError, "code") : undefined),
      errorMessage: safeText(rawError ? own(rawError, "message") : undefined, "", 500),
      enrichmentIssueCount: Array.isArray(enrichmentErrors)
        ? Math.min(enrichmentErrors.length, 1_000)
        : boundedInteger(own(sourceRecord, "enrichment_error_count"), 1_000),
      auth: sanitizeAuth(own(sourceRecord, "auth")),
      tagFacets: site === "exhentai" ? sanitizeFacets(own(sourceRecord, "tag_facets")) : Object.freeze([]),
    });
    candidateOrder[key] = Object.freeze(ids);
    sourceOrder.push(key);
  }

  const relatedProfiles: CrawlProfile[] = [];
  const rawProfiles = root ? own(root, "related_profiles") : null;
  if (Array.isArray(rawProfiles)) {
    const seen = new Set<string>();
    for (const rawProfile of rawProfiles.slice(0, 80)) {
      const profile = safeRecord(rawProfile);
      if (!profile) continue;
      const url = safeExternalProfileUrl(own(profile, "url"));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const artist = safeText(own(profile, "artist_name"), "画师", 100);
      const platform = safeText(own(profile, "platform"), "external", 40);
      relatedProfiles.push(Object.freeze({
        key: `profile:${opaqueUrlKey(url)}`,
        artist,
        platform,
        host: new URL(url).hostname.replace(/^www\./, ""),
        url,
      }));
    }
  }

  return Object.freeze({
    snapshot: Object.freeze({
      sources: Object.freeze(sources) as Readonly<Record<CrawlSourceKey, CrawlSource>>,
      sourceOrder: Object.freeze(sourceOrder),
      candidates: Object.freeze(candidates) as Readonly<Record<CrawlCandidateKey, CrawlCandidate>>,
      candidateOrder: Object.freeze(candidateOrder) as Readonly<Record<CrawlSourceKey, readonly CrawlCandidateKey[]>>,
      relatedProfiles: Object.freeze(relatedProfiles),
      addressCount,
      weakEvidenceCount,
      showWeakEvidence: false,
      ehTagFilter: Object.freeze(emptyRecord<CrawlFilterMode>()),
    }),
    operations,
  });
}

export function sanitizeAutocompleteResponse(value: unknown): readonly CrawlSuggestion[] {
  const root = safeRecord(value);
  const rawItems = root ? own(root, "items") : null;
  if (!Array.isArray(rawItems)) return Object.freeze([]);
  const categories = ["artist", "character", "copyright", "general", "meta"] as const;
  const suggestions: CrawlSuggestion[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems.slice(0, 10)) {
    const record = safeRecord(raw);
    if (!record) continue;
    const suggestionValue = safeText(own(record, "value"), "", 180);
    if (!suggestionValue || seen.has(suggestionValue)) continue;
    seen.add(suggestionValue);
    const rawCategory = own(record, "category");
    const category = typeof rawCategory === "string" && (categories as readonly string[]).includes(rawCategory)
      ? rawCategory as CrawlSuggestion["category"]
      : "general";
    suggestions.push(Object.freeze({
      key: `suggestion:${opaqueUrlKey(suggestionValue)}`,
      value: suggestionValue,
      label: safeText(own(record, "label"), suggestionValue, 180),
      category,
      antecedent: safeText(own(record, "antecedent"), "", 120),
      postCount: boundedInteger(own(record, "post_count")),
    }));
  }
  return Object.freeze(suggestions);
}

export function sanitizeCreatedCrawl(value: unknown): Readonly<{ id: string }> {
  const record = safeRecord(value);
  const id = record ? safeIdentifier(own(record, "id")) : "";
  if (!id) throw new TypeError("invalid_created_crawl");
  return Object.freeze({ id });
}

export function candidateMatchesEhFilter(
  candidate: CrawlCandidate,
  filter: Readonly<Record<string, CrawlFilterMode>>,
): boolean {
  const entries = Object.entries(filter);
  if (!entries.length) return true;
  const keys = new Set(candidate.tags.map(({ key }) => key));
  const includeGroups = new Map<string, string[]>();
  for (const [key, mode] of entries) {
    if (mode === "exclude" && keys.has(key)) return false;
    if (mode !== "include") continue;
    const namespace = key.slice(0, key.indexOf(":"));
    includeGroups.set(namespace, [...(includeGroups.get(namespace) ?? []), key]);
  }
  return [...includeGroups.values()].every((group) => group.some((key) => keys.has(key)));
}

export function visibleCandidateKeys(snapshot: CrawlSnapshot, source: CrawlSourceKey): readonly CrawlCandidateKey[] {
  return (snapshot.candidateOrder[source] ?? []).filter((key) => {
    const candidate = snapshot.candidates[key];
    if (!candidate || (candidate.weak && !snapshot.showWeakEvidence)) return false;
    return candidate.site !== "exhentai" || candidateMatchesEhFilter(candidate, snapshot.ehTagFilter);
  });
}

export function selectedCandidateKeys(snapshot: CrawlSnapshot): readonly CrawlCandidateKey[] {
  return snapshot.sourceOrder.flatMap((source) => (
    snapshot.candidateOrder[source] ?? []
  ).filter((key) => snapshot.candidates[key]?.selected));
}

function validation(field = "", reason = ""): CrawlValidation {
  return Object.freeze({ valid: !reason, field, reason });
}

function validProxyMode(value: unknown): value is CrawlProxyMode {
  return typeof value === "string" && (PROXY_MODES as readonly string[]).includes(value);
}

export function validateSearchDraft(draft: SearchDraft): CrawlValidation {
  const keyword = typeof draft?.keyword === "string" ? draft.keyword.trim() : "";
  if (!keyword || keyword.length > 1_000 || /[\u0000-\u001f\u007f]/.test(keyword)) {
    return validation("keyword", "请输入长度不超过 1000 的有效关键词");
  }
  const sites: readonly CrawlSiteId[] = Array.isArray(draft.sites) ? draft.sites : [];
  if (!sites.some((site) => SITE_IDS.includes(site))) return validation("sites", "至少选择一个搜索来源");
  if (!Number.isInteger(draft.limit) || draft.limit < 1 || draft.limit > CRAWL_PAGE_LIMITS.search) {
    return validation("search-limit", "结果上限需为 1–200 的整数");
  }
  if (!validProxyMode(draft.proxyMode)) return validation("search-proxy", "搜索代理模式无效");
  for (const site of sites) {
    const mode = draft.sourceProxyModes[site];
    if (mode !== undefined && mode !== "" && !validProxyMode(mode)) {
      return validation(`source-${site}`, "来源代理设置无效");
    }
  }
  return validation();
}

export function validateCrawlDraft(draft: CrawlDraft): CrawlValidation {
  if (!Number.isInteger(draft?.concurrency) || draft.concurrency < 1 || draft.concurrency > 128) {
    return validation("concurrency", "每个地址并发数需为 1–128 的整数");
  }
  if (!Number.isInteger(draft.maxTasks) || draft.maxTasks < 1 || draft.maxTasks > CRAWL_PAGE_LIMITS.tasks) {
    return validation("max-tasks", "最多任务数需为 1–100000 的整数");
  }
  if (!validProxyMode(draft.proxyMode)) return validation("crawl-proxy", "下载代理模式无效");
  const output = typeof draft.outputDir === "string" ? draft.outputDir : "";
  if (draft.outputDirInvalid || output.length > 2_048 || /[\u0000-\u001f\u007f]/.test(output)) {
    return validation("output-dir", "输出目录格式无效");
  }
  for (const mode of Object.values(draft.sourceProxyModes)) {
    if (mode !== undefined && mode !== "" && !validProxyMode(mode)) {
      return validation("source-proxy", "来源代理设置无效");
    }
  }
  const { image_mode: imageMode, gp_policy: gpPolicy } = draft.ehDownload;
  if (!(["original", "resample"] as const).includes(imageMode)) return validation("eh-image-mode", "EH 下载图像模式无效");
  if (!(["stop", "resized"] as const).includes(gpPolicy) || (imageMode === "resample" && gpPolicy !== "stop")) {
    return validation("eh-gp-policy", "EH 下载选项无效");
  }
  return validation();
}

export function buildSearchPayload(draft: SearchDraft): Readonly<Record<string, unknown>> {
  const checked = validateSearchDraft(draft);
  if (!checked.valid) throw new TypeError(checked.reason);
  const requested = new Set(draft.sites);
  const sites = SITE_IDS.filter((site) => requested.has(site));
  const sourceOptions = emptyRecord<Readonly<{ proxy_mode: CrawlProxyMode }>>();
  for (const site of sites) {
    const mode = draft.sourceProxyModes[site];
    if (mode) sourceOptions[site] = Object.freeze({ proxy_mode: mode });
  }
  return Object.freeze({
    keyword: draft.keyword.trim(),
    sites: Object.freeze(sites),
    limit: draft.limit,
    proxy_mode: draft.proxyMode,
    source_options: sourceOptions,
  });
}

export function buildCrawlPayload(
  snapshot: CrawlSnapshot,
  operations: ReadonlyMap<CrawlCandidateKey, CrawlOperation>,
  draft: CrawlDraft,
): Readonly<Record<string, unknown>> {
  const checked = validateCrawlDraft(draft);
  if (!checked.valid) throw new TypeError(checked.reason);
  const sources: Array<Record<string, unknown>> = [];
  for (const sourceKeyValue of snapshot.sourceOrder) {
    const source = snapshot.sources[sourceKeyValue];
    const addresses: Array<Record<string, string>> = [];
    for (const key of snapshot.candidateOrder[sourceKeyValue] ?? []) {
      const candidate = snapshot.candidates[key];
      if (!candidate?.selected) continue;
      const operation = operations.get(key);
      if (!operation || operation.site !== source.site || !safeOperationalUrl(operation.url)) {
        throw new TypeError("选中的地址已失效，请重新搜索");
      }
      addresses.push({
        url: operation.url,
        ...(operation.id ? { id: operation.id } : {}),
        ...(operation.label ? { label: operation.label } : {}),
        ...(operation.address_type ? { address_type: operation.address_type } : {}),
      });
    }
    if (!addresses.length) continue;
    const item: Record<string, unknown> = { site: source.site, addresses };
    const sourceMode = draft.sourceProxyModes[source.site];
    if (sourceMode) item.proxy_mode = sourceMode;
    if (source.site === "exhentai") item.eh_download = { ...draft.ehDownload };
    sources.push(item);
  }
  if (!sources.length) throw new TypeError("至少选择一个采集来源");
  const payload: Record<string, unknown> = {
    sources,
    concurrency: draft.concurrency,
    max_tasks: draft.maxTasks,
    proxy_mode: draft.proxyMode,
  };
  const output = draft.outputDir.trim();
  if (output) payload.output_dir = output;
  return Object.freeze(payload);
}

export function crawlErrorPresentation(error: unknown): CrawlErrorPresentation {
  const record = error instanceof Error
    ? { descriptors: Object.getOwnPropertyDescriptors(error) }
    : safeRecord(error);
  const code = safeIdentifier(record ? own(record, "code") : undefined) || "request_failed";
  const rawStatus = record ? own(record, "status") : 0;
  const status = Number.isInteger(rawStatus) ? Number(rawStatus) : 0;
  const requestId = safeIdentifier(record ? own(record, "requestId") : undefined);
  const authentication = /auth|credential|login/i.test(code);
  const proxy = /proxy/i.test(code);
  return Object.freeze({
    code,
    requestId,
    targetApp: authentication ? "vault" : proxy ? "proxy" : "diagnostics",
    title: status === 409 ? "当前状态不允许此操作" : status === 422 ? "采集设置有误" : "采集请求失败",
    message: status === 0 ? "无法连接到 ImageWeave 服务。" : "服务未接受本次请求。",
    nextStep: authentication
      ? "打开授权管理，检查对应站点的授权后重试。"
      : proxy
        ? "打开代理管理，检查代理池的运行状态后重试。"
        : "保留当前选择，修正输入或打开系统诊断检查运行状态。",
  });
}
