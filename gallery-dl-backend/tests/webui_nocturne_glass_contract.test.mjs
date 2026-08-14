import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  dirname,
  extname,
  relative,
  resolve,
} from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(TEST_ROOT, "..");
const WEBUI_ROOT = resolve(BACKEND_ROOT, "gdl_backend", "webui");
const JAVASCRIPT_ROOT = resolve(WEBUI_ROOT, "js");
const STYLES_ROOT = resolve(WEBUI_ROOT, "styles");
const INDEX_PATH = resolve(WEBUI_ROOT, "index.html");
const TOKENS_PATH = resolve(STYLES_ROOT, "tokens.css");
const DESKTOP_PATH = resolve(STYLES_ROOT, "desktop.css");
const NOISE_PATH = resolve(WEBUI_ROOT, "assets", "noise.svg");

const SCENES = Object.freeze({
  graphite: "#080D15",
  slate: "#0B1322",
  "deep-ocean": "#07111B",
  forest: "#081210",
  "plum-gray": "#100C0B",
  "warm-paper": "#120D0A",
});

// This snapshot is intentionally limited to the exported request boundary. It
// does not freeze controller implementation, polling cadence, payload shape, or
// unrelated backend routes.
const BUSINESS_ENDPOINT_SNAPSHOT = Object.freeze({
  crawl: Object.freeze({
    search: "/api/v1/search",
    autocomplete: "/api/v1/search/autocomplete",
    crawls: "/api/v1/crawls",
  }),
  tasks: Object.freeze({ crawls: "/api/v1/crawls" }),
  proxy: Object.freeze({
    status: "/api/v1/proxy/status",
    start: "/api/v1/proxy/start",
    reload: "/api/v1/proxy/reload",
    probe: "/api/v1/proxy/probe",
    stop: "/api/v1/proxy/stop",
    sources: "/api/v1/proxy/sources",
    subscriptions: "/api/v1/proxy/sources/subscriptions",
    nodeFile: "/api/v1/proxy/sources/node-file",
    inlineNodes: "/api/v1/proxy/sources/inline-nodes",
    override: "/api/v1/proxy/sources/override",
  }),
  vault: Object.freeze({
    status: "/api/v1/auth",
    proxy: "/api/v1/auth/proxy",
    browserProfile: "/api/v1/auth/browser-profile",
    pixivOAuthStart: "/api/v1/auth/pixiv/oauth/start",
    pixivOAuthSession: "/api/v1/auth/pixiv/oauth/session",
  }),
  policy: Object.freeze({ policies: "/api/v1/sites/policies" }),
  review: Object.freeze({ crawls: "/api/v1/crawls" }),
  diagnostics: Object.freeze({
    health: "/healthz",
    readiness: "/readyz",
    config: "/api/v1/config?view=diagnostics",
    scheduler: "/api/v1/scheduler/status?view=diagnostics",
  }),
});

const APP_ROUTE_SNAPSHOT = Object.freeze([
  ["crawl", "/crawl", "ready"],
  ["tasks", "/tasks", "ready"],
  ["proxy", "/proxy", "ready"],
  ["vault", "/vault", "ready"],
  ["review", "/review", "ready"],
  ["policy", "/policy", "ready"],
  ["diagnostics", "/diagnostics", "ready"],
  ["personalization", "/personalization", "ready"],
  ["gallery", "/gallery", "preview"],
  ["schedule", "/schedule", "preview"],
  ["export", "/export", "preview"],
]);

function walkFiles(root, suffixes) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path, suffixes));
    else if (entry.isFile() && suffixes.has(extname(path))) files.push(path);
  }
  return files.sort();
}

const CSS_PATHS = walkFiles(STYLES_ROOT, new Set([".css"]));
const JAVASCRIPT_PATHS = walkFiles(JAVASCRIPT_ROOT, new Set([".js"]));
const PRODUCTION_TEXT_PATHS = [INDEX_PATH, ...CSS_PATHS, ...JAVASCRIPT_PATHS];

function label(path) {
  return relative(WEBUI_ROOT, path).replaceAll("\\", "/");
}

function read(path) {
  return readFileSync(path, "utf8");
}

const INDEX_SOURCE = read(INDEX_PATH);
const CSS_SOURCES = new Map(CSS_PATHS.map((path) => [path, read(path)]));
const JS_SOURCES = new Map(JAVASCRIPT_PATHS.map((path) => [path, read(path)]));
const PRODUCTION_SOURCES = new Map(
  PRODUCTION_TEXT_PATHS.map((path) => [path, read(path)]),
);

function check(condition, message, violations) {
  if (!condition) violations.push(message);
}

function renderValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function checkDeepEqual(actual, expected, message, violations) {
  if (!isDeepStrictEqual(actual, expected)) {
    violations.push(`${message}: expected ${renderValue(expected)}, got ${renderValue(actual)}`);
  }
}

function assertNoViolations(title, violations) {
  const limit = 32;
  const shown = violations.slice(0, limit);
  const omitted = violations.length - shown.length;
  assert.equal(
    violations.length,
    0,
    `${title}\n- ${shown.join("\n- ")}${omitted > 0 ? `\n- … ${omitted} more` : ""}`,
  );
}

function moduleUrl(relativePath) {
  return pathToFileURL(resolve(JAVASCRIPT_ROOT, relativePath)).href;
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function stripJavaScriptComments(source) {
  let result = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      result += character;
      if (character === "\\") {
        result += next || "";
        index += 1;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      result += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") result += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    result += character;
  }
  return result;
}

function sourceWithoutComments(path, source) {
  if (extname(path) === ".js") return stripJavaScriptComments(source);
  if (extname(path) === ".css") return stripCssComments(source);
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

function matchingBrace(source, opening) {
  let depth = 0;
  let quote = "";
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  throw new Error("CSS block is not closed");
}

function parseDeclarations(body) {
  const declarations = [];
  const pattern = /(?:^|;)\s*([\w-]+)\s*:\s*([^;{}]+)/g;
  for (const match of body.matchAll(pattern)) {
    declarations.push(Object.freeze({
      property: match[1].toLowerCase(),
      value: match[2].trim(),
    }));
  }
  return declarations;
}

function parseCssRules(source, path) {
  const text = stripCssComments(source);
  const rules = [];

  const visit = (start, end, contexts) => {
    let cursor = start;
    while (cursor < end) {
      while (cursor < end && /\s/.test(text[cursor])) cursor += 1;
      if (cursor >= end) return;
      const opening = text.indexOf("{", cursor);
      const semicolon = text.indexOf(";", cursor);
      if (semicolon >= 0 && semicolon < opening) {
        cursor = semicolon + 1;
        continue;
      }
      if (opening < 0 || opening >= end) return;
      const prelude = text.slice(cursor, opening).trim();
      const closing = matchingBrace(text, opening);
      if (closing > end) throw new Error(`CSS parser crossed block boundary in ${label(path)}`);
      const body = text.slice(opening + 1, closing);
      if (prelude.startsWith("@") && !/^@(?:font-face|page|property)\b/i.test(prelude)) {
        if (!/^@(?:keyframes|-webkit-keyframes)\b/i.test(prelude)) {
          visit(opening + 1, closing, [...contexts, prelude]);
        }
      } else {
        rules.push(Object.freeze({
          path,
          selector: prelude,
          body,
          contexts: Object.freeze([...contexts]),
          declarations: Object.freeze(parseDeclarations(body)),
        }));
      }
      cursor = closing + 1;
    }
  };

  visit(0, text.length, []);
  return rules;
}

const CSS_RULES = CSS_PATHS.flatMap((path) => parseCssRules(CSS_SOURCES.get(path), path));

function declarationsFor(rule, property) {
  return rule.declarations
    .filter((declaration) => declaration.property === property)
    .map((declaration) => declaration.value);
}

function rootTokenDeclarations() {
  const rootRules = CSS_RULES.filter((rule) => (
    rule.path === TOKENS_PATH
    && rule.contexts.length === 0
    && rule.selector.trim() === ":root"
  ));
  return rootRules.flatMap((rule) => rule.declarations);
}

function contextText(rule) {
  return rule.contexts.join(" ").toLowerCase();
}

function isForcedColors(rule) {
  return contextText(rule).includes("forced-colors: active");
}

function isBackdropFallback(rule) {
  const context = contextText(rule);
  return context.includes("@supports not") && context.includes("backdrop-filter");
}

function isNormalVisualRule(rule) {
  const context = contextText(rule);
  return !isForcedColors(rule)
    && !isBackdropFallback(rule)
    && !context.includes("prefers-contrast: more");
}

function htmlStartTag(source, name) {
  return source.match(new RegExp(`<${name}\\b[^>]*>`, "i"))?.[0] || "";
}

function htmlAttribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? null;
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function staticModuleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']\s*;/gm,
    /^\s*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']\s*;/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function javascriptImportGraph() {
  const modules = new Set(JAVASCRIPT_PATHS);
  const graph = new Map(JAVASCRIPT_PATHS.map((path) => [path, new Set()]));
  for (const path of JAVASCRIPT_PATHS) {
    for (const specifier of staticModuleSpecifiers(stripJavaScriptComments(JS_SOURCES.get(path)))) {
      if (!specifier.startsWith(".")) continue;
      let target = resolve(dirname(path), specifier);
      if (!extname(target)) target += ".js";
      assert.equal(modules.has(target), true, `${label(path)} import target missing: ${specifier}`);
      graph.get(path).add(target);
    }
  }
  return graph;
}

const IMPORT_GRAPH = javascriptImportGraph();

function dependencyClosure(entrypoint) {
  const closure = new Set();
  const pending = [entrypoint];
  while (pending.length) {
    const path = pending.pop();
    if (closure.has(path)) continue;
    closure.add(path);
    for (const dependency of IMPORT_GRAPH.get(path) || []) pending.push(dependency);
  }
  return closure;
}

function whiteAlpha(value) {
  const modern = value.match(
    /rgba?\(\s*255(?:\s+|\s*,\s*)255(?:\s+|\s*,\s*)255\s*(?:\/|,)\s*([\d.]+%?)\s*\)/i,
  );
  if (!modern) return null;
  return modern[1].endsWith("%")
    ? Number.parseFloat(modern[1]) / 100
    : Number.parseFloat(modern[1]);
}

function tokenReferenceCount(name) {
  const pattern = new RegExp(`var\\(\\s*${escapeRegExp(name)}(?:\\s*,|\\s*\\))`, "g");
  return CSS_PATHS.reduce((total, path) => total + countMatches(CSS_SOURCES.get(path), pattern), 0);
}

function parseHexColor(value) {
  const normalized = value.slice(1);
  if (normalized.length === 3) {
    return [...normalized].map((channel) => Number.parseInt(channel + channel, 16));
  }
  if (normalized.length === 6 || normalized.length === 8) {
    return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
  }
  return null;
}

function colorFamily([red, green, blue]) {
  const channels = [red, green, blue].map((channel) => channel / 255);
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.24 || delta === 0) return "neutral";
  let hue;
  if (max === channels[0]) hue = 60 * (((channels[1] - channels[2]) / delta) % 6);
  else if (max === channels[1]) hue = 60 * ((channels[2] - channels[0]) / delta + 2);
  else hue = 60 * ((channels[0] - channels[1]) / delta + 4);
  if (hue < 0) hue += 360;
  if (hue >= 255 && hue < 310) return "purple";
  if (hue >= 310 && hue < 355) return "pink";
  return "other";
}

function gradientColorFamilies(value) {
  const families = new Set();
  for (const match of value.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
    const color = parseHexColor(match[0]);
    if (color) families.add(colorFamily(color));
  }
  for (const match of value.matchAll(/rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/[^)]*)?\)/gi)) {
    families.add(colorFamily(match.slice(1, 4).map(Number)));
  }
  return families;
}

function timeout(promise, milliseconds = 800) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("operation timed out")), milliseconds);
    }),
  ]);
}

function deletionIndexedDbFixture() {
  const calls = {
    open: [],
    transactions: [],
    deletes: [],
    closes: 0,
  };
  const database = {
    objectStoreNames: { contains: (name) => name === "wallpapers" },
    transaction(name, mode) {
      calls.transactions.push([name, mode]);
      const transaction = {
        error: null,
        objectStore(storeName) {
          assert.equal(storeName, "wallpapers");
          return {
            delete(key) {
              calls.deletes.push(key);
              const request = { result: undefined, error: null };
              queueMicrotask(() => {
                request.onsuccess?.({ target: request });
                transaction.oncomplete?.({ target: transaction });
              });
              return request;
            },
          };
        },
      };
      return transaction;
    },
    close() {
      calls.closes += 1;
    },
  };
  const indexedDB = {
    open(...args) {
      calls.open.push(args);
      const request = { result: database, error: null };
      queueMicrotask(() => request.onsuccess?.({ target: request }));
      return request;
    },
  };
  return { calls, indexedDB };
}

test("[theme] root is permanently dark and runtime cannot write root color tokens", () => {
  const violations = [];
  const html = htmlStartTag(INDEX_SOURCE, "html");
  check(htmlAttribute(html, "data-theme-tone") === "dark", "index <html> must set data-theme-tone=dark", violations);
  const colorMeta = [...INDEX_SOURCE.matchAll(/<meta\b[^>]*>/gi)]
    .map((match) => match[0])
    .find((tag) => htmlAttribute(tag, "name")?.toLowerCase() === "color-scheme") || "";
  check(htmlAttribute(colorMeta, "content") === "dark", "index color-scheme meta must be dark", violations);

  const tokenSource = CSS_SOURCES.get(TOKENS_PATH);
  check(/:root\s*\{[\s\S]*?color-scheme\s*:\s*dark\s*;/i.test(tokenSource), "tokens :root must declare color-scheme: dark", violations);
  for (const [path, source] of CSS_SOURCES) {
    if (/data-theme-tone\s*=\s*["']light["']/i.test(source)) violations.push(`${label(path)} retains a light theme selector`);
    if (/color-scheme\s*:\s*light\b/i.test(source)) violations.push(`${label(path)} retains color-scheme: light`);
  }

  const colorWrite = /\.setProperty\(\s*["']--imageweave-(?:accent|surface|text|state|border|focus)[\w-]*["']/g;
  const toneWrite = /(?:\.setAttribute\(\s*["']data-theme-tone["']|\.dataset\.themeTone\s*=)/g;
  for (const [path, source] of JS_SOURCES) {
    const executable = stripJavaScriptComments(source);
    for (const match of executable.matchAll(colorWrite)) violations.push(`${label(path)} writes ${match[0]}`);
    for (const match of executable.matchAll(toneWrite)) violations.push(`${label(path)} writes data-theme-tone`);
    if (/\bthemeRoot\b/.test(executable)) violations.push(`${label(path)} retains a mutable themeRoot channel`);
  }
  assertNoViolations("fixed-dark root contract", violations);
});

test("[preferences] model whitelist is scene plus motion and legacy custom records fall back safely", async () => {
  const violations = [];
  const model = await import(moduleUrl("core/personalization-model.js"));
  checkDeepEqual(
    [...(model.PERSONALIZATION_PREFERENCE_KEYS || [])].sort(),
    ["animations", "wallpaperColor"],
    "PERSONALIZATION_PREFERENCE_KEYS",
    violations,
  );
  checkDeepEqual(
    Object.keys(model.PERSONALIZATION_OPTIONS || {}).sort(),
    ["animations", "wallpaperColor"],
    "PERSONALIZATION_OPTIONS keys",
    violations,
  );
  checkDeepEqual(
    Object.keys(model.PERSONALIZATION_DEFAULTS || {}).sort(),
    ["animations", "wallpaperColor"],
    "PERSONALIZATION_DEFAULTS keys",
    violations,
  );
  checkDeepEqual(
    [...(model.BUILT_IN_WALLPAPER_COLOR_IDS || [])].sort(),
    Object.keys(SCENES).sort(),
    "built-in scene IDs",
    violations,
  );

  const normalize = model.normalizePersonalizationPreferences;
  const project = model.projectPersonalizationPreferences;
  check(typeof normalize === "function", "normalizePersonalizationPreferences must remain callable", violations);
  check(typeof project === "function", "projectPersonalizationPreferences must remain callable", violations);
  if (typeof normalize === "function") {
    let getterReads = 0;
    const legacy = {
      animations: "off",
      wallpaperKind: "custom",
      wallpaperColor: "forest",
      wallpaperFit: "tile",
      wallpaperPosition: "bottom-right",
      wallpaperMaskTone: "light",
      wallpaperMaskStrength: 80,
      wallpaperBlur: "medium",
      windowOpacity: "soft",
    };
    Object.defineProperty(legacy, "themeAccent", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "#FF00FF";
      },
    });
    try {
      checkDeepEqual(
        normalize(legacy),
        { animations: "off", wallpaperColor: "graphite" },
        "legacy custom normalization",
        violations,
      );
      check(getterReads === 0, "legacy accessor fields must not be evaluated", violations);
      checkDeepEqual(
        normalize({ animations: "on", wallpaperColor: "unknown" }),
        { animations: "on", wallpaperColor: "graphite" },
        "unknown scene fallback",
        violations,
      );
    } catch (error) {
      violations.push(`normalization threw ${error?.name || "Error"}: ${error?.message || error}`);
    }
  }
  if (typeof project === "function") {
    try {
      checkDeepEqual(
        project({ animations: "on", wallpaperColor: "forest" }),
        { animations: "on", wallpaperColor: "forest" },
        "strict preference projection",
        violations,
      );
      let rejectedLegacyWrite = false;
      try {
        project({ animations: "on", wallpaperColor: "forest", themeAccent: "#ABCDEF" });
      } catch {
        rejectedLegacyWrite = true;
      }
      check(rejectedLegacyWrite, "strict writes must reject retired theme fields", violations);
    } catch (error) {
      violations.push(`strict projection threw unexpectedly: ${error?.message || error}`);
    }
  }
  assertNoViolations("personalization preference model contract", violations);
});

test("[preferences] storage migration never writes retired fields or unused taskbar density", async () => {
  const violations = [];
  const storage = await import(moduleUrl("core/storage-preferences.js"));
  const expected = { animations: "off", wallpaperColor: "graphite" };
  const legacy = {
    animations: "off",
    wallpaperKind: "custom",
    wallpaperColor: "warm-paper",
    themeAccent: "#F000AA",
    themeSurface: "#FAFAFA",
    wallpaperFit: "contain",
    wallpaperPosition: "top-left",
    wallpaperMaskTone: "light",
    wallpaperMaskStrength: 75,
    wallpaperBlur: "medium",
    windowOpacity: "soft",
    taskbarDensity: "compact",
  };

  const actualTaskbarConsumers = [...JS_SOURCES.entries()]
    .filter(([path, source]) => path !== resolve(JAVASCRIPT_ROOT, "core", "storage-preferences.js") && /\btaskbarDensity\b/.test(source))
    .map(([path]) => label(path));
  checkDeepEqual(actualTaskbarConsumers, [], "production taskbarDensity consumers", violations);

  for (const name of [
    "deserializeUiPreferences",
    "serializeUiPreferences",
    "serializePersonalizationPreferences",
  ]) {
    check(typeof storage[name] === "function", `${name} must remain callable`, violations);
  }
  try {
    if (typeof storage.deserializeUiPreferences === "function") {
      checkDeepEqual(
        storage.deserializeUiPreferences(JSON.stringify(legacy)),
        expected,
        "legacy storage migration",
        violations,
      );
    }
    const serialized = [];
    if (typeof storage.serializeUiPreferences === "function") {
      serialized.push(storage.serializeUiPreferences({ animations: "off", wallpaperColor: "graphite" }));
    }
    if (typeof storage.serializePersonalizationPreferences === "function") {
      serialized.push(storage.serializePersonalizationPreferences(
        { animations: "off", wallpaperColor: "graphite" },
        JSON.stringify(legacy),
      ));
    }
    for (const [index, value] of serialized.entries()) {
      checkDeepEqual(JSON.parse(value), expected, `serialized preference payload ${index + 1}`, violations);
      for (const retired of [
        "themeAccent", "themeSurface", "wallpaperKind", "wallpaperFit",
        "wallpaperPosition", "wallpaperMaskTone", "wallpaperMaskStrength",
        "wallpaperBlur", "windowOpacity", "taskbarDensity", "image", "blob",
      ]) {
        check(!value.includes(retired), `serialized payload writes retired field ${retired}`, violations);
      }
    }
  } catch (error) {
    violations.push(`storage migration/serialization threw: ${error?.message || error}`);
  }
  assertNoViolations("UI preference storage contract", violations);
});

test("[retired UI] production has no color/file inputs, custom image path, mask, Object URL, or opacity choice", () => {
  const violations = [];
  const inputPatterns = [
    /<input\b[^>]*\btype\s*=\s*["'](?:color|file)["']/gi,
    /\btype\s*:\s*["'](?:color|file)["']/g,
  ];
  const objectUrlPattern = /\b(?:URL\s*\.\s*)?(?:createObjectURL|revokeObjectURL)\b|["'`]blob:/g;
  for (const [path, source] of PRODUCTION_SOURCES) {
    const executable = sourceWithoutComments(path, source);
    for (const pattern of inputPatterns) {
      for (const match of executable.matchAll(pattern)) violations.push(`${label(path)} retains ${match[0]}`);
    }
    for (const match of executable.matchAll(objectUrlPattern)) violations.push(`${label(path)} retains Object URL path ${match[0]}`);
  }

  const runtimePaths = [
    "index.html",
    "js/main.js",
    "js/core/personalization.js",
    "js/apps/personalization.js",
    "js/components/personalization-view.js",
  ];
  const retiredRuntimePatterns = [
    /data-desktop-wallpaper-(?:image|mask)/i,
    /desktop-wallpaper__(?:image|image-layer|mask)/i,
    /desktop-wallpaper--custom/i,
    /\bwallpaperImage\b/,
    /\bwallpaperMask\b/,
    /\bpreviewCustomImage\b/,
    /\bimportWallpaperImage\b/,
    /\bprobeWallpaperImageBlob\b/,
    /\bwallpaper(?:Fit|Position|MaskTone|MaskStrength|Blur)\b/,
    /\bwindowOpacity\b/,
    /window-layer--opacity-(?:solid|subtle|soft)/,
  ];
  for (const relativePath of runtimePaths) {
    const path = resolve(WEBUI_ROOT, relativePath);
    if (!existsSync(path)) continue;
    const source = sourceWithoutComments(path, read(path));
    for (const pattern of retiredRuntimePatterns) {
      if (pattern.test(source)) violations.push(`${relativePath} retains ${pattern}`);
    }
  }
  for (const [path, source] of CSS_SOURCES) {
    for (const pattern of [
      /desktop-wallpaper__(?:image|image-layer|mask)/i,
      /desktop-wallpaper--(?:custom|fit-|position-|mask-|blur-)/i,
      /personalization-preview-wallpaper--custom/i,
      /window-layer--opacity-(?:solid|subtle|soft)/i,
    ]) {
      if (pattern.test(source)) violations.push(`${label(path)} retains ${pattern}`);
    }
  }
  check(!existsSync(resolve(JAVASCRIPT_ROOT, "core", "wallpaper-image-import.js")), "wallpaper-image-import.js must be deleted", violations);
  assertNoViolations("retired personalization UI/runtime contract", violations);
});

test("[legacy cleanup] wallpaper storage exposes one best-effort delete-only migration seam", async () => {
  const violations = [];
  const storagePath = resolve(JAVASCRIPT_ROOT, "core", "wallpaper-storage.js");
  check(existsSync(storagePath), "wallpaper-storage.js cleanup seam must remain for one compatibility cycle", violations);
  if (!existsSync(storagePath)) {
    assertNoViolations("legacy wallpaper cleanup seam", violations);
    return;
  }

  const source = stripJavaScriptComments(read(storagePath));
  for (const [pattern, reason] of [
    [/wallpaper-image-import/, "imports the deleted image importer"],
    [/WALLPAPER_IMAGE_LIMITS|hasSafeWallpaperOutputSignature/, "validates or reads image content"],
    [/\bBlob(?:Constructor)?\b|\bmediaType\b|\bupdatedAt\b/, "retains image record fields"],
    [/\.get\s*\(/, "reads wallpaper records"],
    [/\.put\s*\(/, "writes wallpaper records"],
    [/\breadonly\b/, "opens a read transaction"],
    [/createObjectStore|onupgradeneeded/, "creates or upgrades wallpaper storage"],
  ]) {
    if (pattern.test(source)) violations.push(`wallpaper-storage.js ${reason}`);
  }
  check(source.includes('"imageweave-ui"'), "cleanup seam must target database imageweave-ui", violations);
  check(source.includes('"wallpapers"'), "cleanup seam must target store wallpapers", violations);
  check(source.includes('"custom"'), "cleanup seam must target key custom", violations);
  check(countMatches(source, /\.delete\s*\(/g) === 1, "cleanup seam must issue exactly one delete operation", violations);

  const storageModule = await import(pathToFileURL(storagePath).href);
  const callableExports = Object.entries(storageModule).filter(([, value]) => (
    typeof value === "function" && !/^class\s/.test(Function.prototype.toString.call(value))
  ));
  const cleanupExports = callableExports.filter(([name]) => (
    /(?:cleanup|delete|remove).*wallpaper|wallpaper.*(?:cleanup|delete|remove)/i.test(name)
  ));
  check(cleanupExports.length === 1, `cleanup seam must expose one auditable delete operation; got ${cleanupExports.map(([name]) => name).join(", ") || "none"}`, violations);
  const retiredExports = [
    "createWallpaperStorage",
    "normalizeWallpaperStorageError",
    "projectWallpaperImportResult",
    "projectWallpaperRecord",
  ].filter((name) => name in storageModule);
  check(retiredExports.length === 0, `cleanup seam retains old repository exports: ${retiredExports.join(", ")}`, violations);

  if (cleanupExports.length === 1) {
    const [name, cleanup] = cleanupExports[0];
    const mainSource = JS_SOURCES.get(resolve(JAVASCRIPT_ROOT, "main.js"));
    check(countMatches(mainSource, new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g")) === 1, `main.js must invoke ${name} exactly once`, violations);
    const fixture = deletionIndexedDbFixture();
    try {
      await timeout(cleanup({ indexedDB: fixture.indexedDB }));
      checkDeepEqual(fixture.calls.transactions, [["wallpapers", "readwrite"]], "cleanup transaction", violations);
      checkDeepEqual(fixture.calls.deletes, ["custom"], "cleanup delete key", violations);
      check(fixture.calls.closes === 1, `cleanup must close its connection once; got ${fixture.calls.closes}`, violations);
    } catch (error) {
      violations.push(`${name} could not complete delete-only fixture: ${error?.message || error}`);
    }
    try {
      await timeout(cleanup({ indexedDB: null }));
    } catch (error) {
      violations.push(`${name} rejects when IndexedDB is unavailable: ${error?.message || error}`);
    }
  }
  assertNoViolations("legacy wallpaper cleanup seam", violations);
});

test("[scenes] all six retained IDs are deep scenes with at least two radial light wells", () => {
  const violations = [];
  const desktopRules = CSS_RULES.filter((rule) => rule.path === DESKTOP_PATH && rule.contexts.length === 0);
  for (const [scene, base] of Object.entries(SCENES)) {
    const selector = `.desktop-wallpaper--${scene}`;
    const rules = desktopRules.filter((rule) => rule.selector.split(",").map((part) => part.trim()).includes(selector));
    check(rules.length > 0, `${selector} is missing`, violations);
    const body = rules.map((rule) => rule.body).join("\n");
    const radialCount = countMatches(body, /radial-gradient\s*\(/gi);
    check(radialCount >= 2, `${selector} has ${radialCount} radial light wells (need >= 2)`, violations);
    check(body.toUpperCase().includes(base), `${selector} must retain deep base ${base}`, violations);
    check(!/^\s*background(?:-color)?\s*:\s*#[0-9a-f]{3,8}\s*;?\s*$/i.test(body.trim()), `${selector} must not be a flat color`, violations);
  }
  assertNoViolations("built-in nocturne scene contract", violations);
});

test("[noise] SVG is safe, same-origin, and mounted exactly once", () => {
  const violations = [];
  check(existsSync(NOISE_PATH), "assets/noise.svg is missing", violations);
  if (existsSync(NOISE_PATH)) {
    const svg = read(NOISE_PATH);
    check(/<svg\b/i.test(svg), "noise.svg has no svg root", violations);
    check(/<feTurbulence\b/i.test(svg), "noise.svg must use feTurbulence", violations);
    for (const [pattern, reason] of [
      [/<script\b/i, "script"],
      [/<foreignObject\b/i, "foreignObject"],
      [/<!DOCTYPE/i, "DOCTYPE"],
      [/\son[a-z]+\s*=/i, "event handler"],
      [/(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i, "external/data reference"],
    ]) {
      if (pattern.test(svg)) violations.push(`noise.svg contains unsafe ${reason}`);
    }
  }

  const references = [];
  for (const rule of CSS_RULES) {
    for (const match of rule.body.matchAll(/url\(\s*["']?[^"')]*noise\.svg["']?\s*\)/gi)) {
      references.push({ path: rule.path, index: match.index });
    }
  }
  for (const match of INDEX_SOURCE.matchAll(/\b(?:src|href)\s*=\s*["'][^"']*noise\.svg["']/gi)) {
    references.push({ path: INDEX_PATH, index: match.index });
  }
  for (const [path, source] of JS_SOURCES) {
    for (const match of source.matchAll(/["'][^"']*noise\.svg["']/gi)) references.push({ path, index: match.index });
  }
  check(references.length === 1, `production must reference noise.svg once; got ${references.length}`, violations);
  const noiseRules = CSS_RULES.filter((rule) => /noise\.svg/i.test(rule.body));
  check(noiseRules.length === 1, `noise.svg must be attached by one CSS rule; got ${noiseRules.length}`, violations);
  if (noiseRules.length === 1) {
    const rule = noiseRules[0];
    const url = rule.body.match(/url\(\s*["']?([^"')]+noise\.svg)["']?\s*\)/i)?.[1] || "";
    check(url.startsWith(".") && !/^(?:[a-z]+:|\/\/|\/)/i.test(url), `noise URL must be relative and same-origin: ${url || "missing"}`, violations);
    if (url) check(resolve(dirname(rule.path), url) === NOISE_PATH, `noise URL resolves outside canonical asset: ${url}`, violations);
    const rawOpacity = declarationsFor(rule, "opacity").at(-1) || "";
    const opacity = rawOpacity.endsWith("%")
      ? Number.parseFloat(rawOpacity) / 100
      : Number.parseFloat(rawOpacity);
    check(opacity >= 0.02 && opacity <= 0.03, `noise opacity must be 2%-3%; got ${Number.isFinite(opacity) ? opacity : "missing"}`, violations);
    check(declarationsFor(rule, "pointer-events").includes("none"), "noise layer must use pointer-events: none", violations);
    check(declarationsFor(rule, "position").some((value) => value === "fixed"), "noise layer must be fixed", violations);
    check(declarationsFor(rule, "inset").some((value) => value === "0"), "noise layer must cover the viewport once", violations);

    const selectors = rule.selector.split(",").map((value) => value.trim()).filter(Boolean);
    check(selectors.length === 1, `noise rule creates ${selectors.length} selectors/layers`, violations);
    const selector = selectors[0] || "";
    if (!selector.includes("::")) {
      const className = selector.match(/\.([\w-]*noise[\w-]*)/i)?.[1] || "";
      check(Boolean(className), `noise DOM layer needs an auditable noise class: ${selector}`, violations);
      if (className) {
        check(countMatches(INDEX_SOURCE, new RegExp(`\\b${escapeRegExp(className)}\\b`, "g")) === 1, `${className} must be mounted once in index.html`, violations);
      }
    }
    const forcedRule = CSS_RULES.find((candidate) => (
      isForcedColors(candidate)
      && candidate.selector.split(",").map((value) => value.trim()).includes(selector)
      && candidate.declarations.some(({ property, value }) => (
        (property === "display" && /none/.test(value))
        || (property === "background-image" && /none/.test(value))
        || (property === "content" && /none/.test(value))
      ))
    ));
    check(Boolean(forcedRule), `forced-colors must remove the noise selector ${selector}`, violations);
  }

  assertNoViolations("single safe noise layer contract", violations);
});

test("[glass tokens] neutral low-alpha surfaces, optical depth, blur, saturation, accent, and radii are exact", () => {
  const violations = [];
  const declarations = rootTokenDeclarations();
  const custom = declarations.filter(({ property }) => property.startsWith("--imageweave-"));
  const alphaTokens = custom
    .map((declaration) => ({ ...declaration, alpha: whiteAlpha(declaration.value) }))
    .filter(({ property, alpha }) => alpha !== null && /(?:surface|glass)/.test(property));
  for (const alpha of [0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15]) {
    const matching = alphaTokens.filter((token) => Math.abs(token.alpha - alpha) < 0.0001);
    check(matching.length > 0, `missing neutral white surface token at ${Math.round(alpha * 100)}%`, violations);
    if (matching.length > 0) {
      check(matching.some((token) => tokenReferenceCount(token.property) > 0), `${Math.round(alpha * 100)}% surface token is not consumed`, violations);
    }
  }
  for (const token of alphaTokens) {
    if (token.alpha > 0.12 && !/(?:hover|focus)/.test(token.property)) {
      violations.push(`${token.property} uses ${token.alpha * 100}% outside hover/focus`);
    }
    if (token.alpha > 0.15) violations.push(`${token.property} exceeds the 15% glass ceiling`);
  }

  const blur40 = custom.filter(({ property, value }) => /blur/.test(property) && value === "40px");
  const blur60 = custom.filter(({ property, value }) => /blur/.test(property) && value === "60px");
  check(blur40.length > 0 || /blur\(\s*40px\s*\)/.test([...CSS_SOURCES.values()].join("\n")), "40px glass blur is missing", violations);
  check(blur60.length > 0 || /blur\(\s*60px\s*\)/.test([...CSS_SOURCES.values()].join("\n")), "60px glass blur is missing", violations);
  for (const token of [...blur40, ...blur60]) check(tokenReferenceCount(token.property) > 0, `${token.property} is not consumed`, violations);

  const saturate180 = custom.filter(({ property, value }) => /saturat/.test(property) && value === "180%");
  const allCss = [...CSS_SOURCES.values()].join("\n");
  check(saturate180.length > 0 || /saturate\(\s*180%\s*\)/.test(allCss), "180% saturation is missing", violations);
  for (const token of saturate180) check(tokenReferenceCount(token.property) > 0, `${token.property} is not consumed`, violations);

  const rootByProperty = new Map(custom.map(({ property, value }) => [property, value]));
  check(rootByProperty.get("--imageweave-accent")?.toUpperCase() === "#E4B863", "--imageweave-accent must be #E4B863", violations);
  check(custom.some(({ value }) => value.toUpperCase() === "#F3DCA8"), "champagne highlight #F3DCA8 is missing", violations);

  const radiusTokens = custom.filter(({ property }) => /radius/.test(property));
  for (const radius of ["16px", "24px"]) {
    const matching = radiusTokens.filter(({ value }) => value === radius);
    check(matching.length > 0, `radius ${radius} token is missing`, violations);
    if (matching.length > 0) {
      check(matching.some((token) => tokenReferenceCount(token.property) > 0), `radius ${radius} token is not consumed`, violations);
    }
  }
  for (const token of radiusTokens) {
    if (!new Set(["16px", "24px", "999px", "50%"]).has(token.value)) {
      violations.push(`${token.property} retains non-contract radius ${token.value}`);
    }
  }

  const shadowValues = custom.filter(({ property }) => /shadow/.test(property)).map(({ value }) => value).join("\n");
  check(/inset\s+0\s+1px\s+0\s+rgb\(\s*255\s+255\s+255\s*\//i.test(shadowValues), "directional top inset highlight is missing", violations);
  check(/inset\s+0\s+-1px\s+0\s+rgb\(/i.test(shadowValues), "directional bottom inset shade is missing", violations);
  check(/0\s+16px\s+(?:40|48)px\s+rgb\(/i.test(shadowValues), "deep external glass shadow is missing", violations);

  const alphaByToken = new Map(alphaTokens.map(({ property, alpha }) => [property, alpha]));
  for (const rule of CSS_RULES.filter(isNormalVisualRule)) {
    for (const declaration of rule.declarations) {
      if (!/^background(?:-color)?$/.test(declaration.property) || /gradient\(/i.test(declaration.value)) continue;
      const alphas = [];
      const direct = whiteAlpha(declaration.value);
      if (
        direct !== null
        && !/(?:wallpaper|media|image|canvas|traffic|progress|grain|shape)/i.test(rule.selector)
      ) alphas.push(direct);
      for (const match of declaration.value.matchAll(/var\(\s*(--imageweave-[\w-]+)/g)) {
        if (alphaByToken.has(match[1])) alphas.push(alphaByToken.get(match[1]));
      }
      for (const alpha of alphas) {
        const ceiling = /:hover|:focus/.test(rule.selector) ? 0.15 : 0.12;
        if (alpha > ceiling + 0.0001) violations.push(`${label(rule.path)} ${rule.selector} uses ${alpha * 100}% glass above ${ceiling * 100}%`);
      }
    }
  }
  assertNoViolations("nocturne glass token contract", violations);
});

test("[motion] normal visuals use 500ms spring while drag and resize remain immediate", () => {
  const violations = [];
  const normalRules = CSS_RULES.filter((rule) => (
    isNormalVisualRule(rule)
    && !contextText(rule).includes("prefers-reduced-motion")
    && !/data-motion\s*=\s*["']off["']/.test(rule.selector)
  ));
  for (const rule of normalRules) {
    for (const declaration of rule.declarations) {
      const fastDurations = [...new Set(
        [...declaration.value.matchAll(/\b(?:120|150|180)ms\b/g)].map((match) => match[0]),
      )];
      if (fastDurations.length > 0) {
        violations.push(`${label(rule.path)} ${rule.selector} ${declaration.property} retains ${fastDurations.join("/")}`);
      }
    }
  }
  const normalCss = normalRules.map((rule) => rule.body).join("\n");
  check(/\b500ms\b/.test(normalCss), "normal visual CSS has no 500ms duration", violations);
  check(/cubic-bezier\(\s*0\.16\s*,\s*1\s*,\s*0\.3\s*,\s*1\s*\)/.test(normalCss), "spring easing cubic-bezier(0.16, 1, 0.3, 1) is missing", violations);

  const interactionRule = CSS_RULES.find((rule) => (
    rule.path === DESKTOP_PATH
    && /data-window-interacting/.test(rule.selector)
    && declarationsFor(rule, "transition").some((value) => value === "none")
  ));
  check(Boolean(interactionRule), "window interaction selector must disable transitions", violations);
  const interactionSource = JS_SOURCES.get(resolve(JAVASCRIPT_ROOT, "core", "window-interaction.js"));
  const managerSource = JS_SOURCES.get(resolve(JAVASCRIPT_ROOT, "core", "window-manager.js"));
  check(/setAttribute\(\s*["']data-window-interacting["']\s*,\s*type\s*\)/.test(interactionSource), "window interaction runtime must mark direct manipulation", violations);
  check(/startPointerInteraction\([^;]+["']drag["']/.test(managerSource), "drag path does not use the interaction marker", violations);
  check(/startPointerInteraction\([^;]+["']resize["']/.test(managerSource), "resize path does not use the interaction marker", violations);
  assertNoViolations("motion and direct-manipulation contract", violations);
});

test("[fallbacks] forced colors, reduced motion, data-motion off, and no-backdrop paths stay readable", () => {
  const violations = [];
  const forced = CSS_RULES.filter(isForcedColors);
  check(forced.length > 0, "forced-colors rules are missing", violations);
  for (const [property, expected] of [
    ["background-image", "none"],
    ["box-shadow", "none"],
    ["backdrop-filter", "none"],
  ]) {
    check(forced.some((rule) => declarationsFor(rule, property).some((value) => value.includes(expected))), `forced-colors does not disable ${property}`, violations);
  }
  check(forced.some((rule) => rule.declarations.some(({ property, value }) => (
    property === "background" && /\b(?:Canvas|ButtonFace|Highlight)\b/.test(value)
  ))), "forced-colors has no system solid background", violations);

  const reduced = CSS_RULES.filter((rule) => contextText(rule).includes("prefers-reduced-motion: reduce"));
  check(reduced.some((rule) => rule.declarations.some(({ property, value }) => (
    (property === "transition" && value === "none")
    || (property === "transition-property" && value.includes("none"))
  ))), "prefers-reduced-motion does not disable transitions", violations);
  const motionOff = CSS_RULES.filter((rule) => /data-motion\s*=\s*["']off["']/.test(rule.selector));
  check(motionOff.some((rule) => rule.declarations.some(({ property, value }) => (
    (property === "transition" && value === "none")
    || (property === "transition-property" && value.includes("none"))
  ))), "data-motion=off does not disable transitions", violations);

  const noBackdrop = CSS_RULES.filter(isBackdropFallback);
  check(noBackdrop.length > 0, "@supports not backdrop-filter fallback is missing", violations);
  check(noBackdrop.some((rule) => rule.declarations.some(({ property, value }) => (
    /^background/.test(property) && (/(?:solid|Canvas|#[0-9a-f]{3,8})/i.test(value))
  ))), "no-backdrop fallback has no readable solid surface", violations);
  assertNoViolations("accessibility and capability fallback contract", violations);
});

test("[legacy visual] no 92%-100% surfaces, tinted status fills, one-sided thick bars, or repeated tracked kickers", () => {
  const findings = {
    opaqueSurfaces: [],
    tintedStatusFills: [],
    oneSidedBars: [],
    trackedKickers: [],
  };
  for (const rule of CSS_RULES.filter(isNormalVisualRule)) {
    const location = `${label(rule.path)} ${rule.selector.replace(/\s+/g, " ").trim()}`;
    const backgrounds = rule.declarations.filter(({ property }) => /^background(?:-color)?$/.test(property));
    for (const declaration of rule.declarations) {
      if (
        declaration.property.startsWith("--imageweave-")
        && /surface/.test(declaration.property)
        && /color-mix\([^;]*(?:9[2-9]|100)%/i.test(declaration.value)
      ) {
        findings.opaqueSurfaces.push(`${label(rule.path)} ${declaration.property}`);
      }
      if (/^background(?:-color)?$/.test(declaration.property)) {
        if (/color-mix\([^;]*transparent[^;]*(?:9[2-9]|100)%|color-mix\([^;]*(?:9[2-9]|100)%[^;]*transparent/i.test(declaration.value)) {
          findings.opaqueSurfaces.push(location);
        }
        if (
          /var\(\s*--imageweave-[\w-]*surface[\w-]*-solid\s*\)/i.test(declaration.value)
          && !backgrounds.some((candidate) => candidate !== declaration && !/-solid\s*\)/.test(candidate.value))
        ) {
          findings.opaqueSurfaces.push(location);
        }
        if (/var\(\s*--imageweave-state-[\w-]*-surface\s*\)/i.test(declaration.value)) {
          findings.tintedStatusFills.push(location);
        }
        const alpha = whiteAlpha(declaration.value);
        if (alpha !== null && alpha >= 0.92) findings.opaqueSurfaces.push(location);
      }
      if (/^border-(?:left|right|top|bottom)$/.test(declaration.property)) {
        const width = Number.parseFloat(declaration.value.match(/^([\d.]+)px\b/)?.[1] || "0");
        if (width >= 3 && !/(?:resize|traffic|dock)/.test(rule.selector)) {
          findings.oneSidedBars.push(`${location} ${declaration.property}: ${declaration.value}`);
        }
      }
      if (declaration.property === "box-shadow" && !/(?:resize|traffic|dock)/.test(rule.selector)) {
        for (const match of declaration.value.matchAll(/inset\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+0(?:px)?(?:\s|,|$)/g)) {
          const [x, y] = match.slice(1, 3).map((value) => Math.abs(Number(value)));
          if ((x >= 3 && y === 0) || (y >= 3 && x === 0)) {
            findings.oneSidedBars.push(`${location} ${match[0].trim()}`);
          }
        }
      }
    }
    const uppercase = declarationsFor(rule, "text-transform").some((value) => value === "uppercase");
    const tracked = declarationsFor(rule, "letter-spacing").some((value) => {
      const amount = Number.parseFloat(value.match(/^([\d.]+)em$/)?.[1] || "0");
      return amount >= 0.06;
    });
    if (uppercase && tracked && /(?:kicker|eyebrow|column-(?:label|number))/i.test(rule.selector)) {
      findings.trackedKickers.push(location);
    }
  }

  const violations = [];
  for (const [name, items] of Object.entries(findings)) {
    const unique = [...new Set(items)];
    if (unique.length > 0) violations.push(`${name} (${unique.length}): ${unique.slice(0, 5).join(" | ")}`);
  }
  assertNoViolations("legacy visual token/decoration contract", violations);
});

test("[gradient safety] no purple-pink gradient combination or gradient text, while radial wells and semantic colors remain legal", () => {
  const violations = [];
  const selectorFacts = new Map();
  for (const rule of CSS_RULES.filter(isNormalVisualRule)) {
    const fact = selectorFacts.get(rule.selector) || { gradient: false, clipText: false, transparentText: false };
    for (const declaration of rule.declarations) {
      if (/^background(?:-image)?$/.test(declaration.property) && /(?:linear|radial)-gradient\(/i.test(declaration.value)) {
        fact.gradient = true;
        const families = gradientColorFamilies(declaration.value);
        const namedPurple = /\b(?:purple|violet|fuchsia|magenta)\b/i.test(declaration.value);
        const namedPink = /\b(?:pink|hotpink|deeppink)\b/i.test(declaration.value);
        if ((families.has("purple") && families.has("pink")) || (namedPurple && namedPink)) {
          violations.push(`${label(rule.path)} ${rule.selector} combines purple and pink in a gradient`);
        }
      }
      if (/^(?:-webkit-)?background-clip$/.test(declaration.property) && /text/.test(declaration.value)) fact.clipText = true;
      if ((declaration.property === "color" || /text-fill-color$/.test(declaration.property)) && /transparent/.test(declaration.value)) fact.transparentText = true;
    }
    selectorFacts.set(rule.selector, fact);
  }
  for (const [selector, fact] of selectorFacts) {
    if (fact.gradient && fact.clipText && fact.transparentText) violations.push(`${selector} uses gradient text`);
  }
  assertNoViolations("gradient safety contract", violations);
});

test("[architecture] registry and Router preserve the 11-app desktop/deep-link boundary", async () => {
  const definitions = await import(moduleUrl("core/app-definitions.js"));
  const registry = await import(moduleUrl("core/app-registry.js"));
  const router = await import(moduleUrl("core/router.js"));

  assert.deepEqual(
    definitions.applicationDefinitions.map(({ id, route, availability }) => [id, route, availability]),
    APP_ROUTE_SNAPSHOT,
  );
  assert.equal(registry.applications.length, 11);
  for (const [id, route] of APP_ROUTE_SNAPSHOT) {
    const application = registry.getApplicationById(id);
    assert.equal(application?.route, route, id);
    for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
      assert.equal(typeof application?.[hook], "function", `${id}.${hook}`);
    }
    assert.equal(router.parseHashRoute(`#${route}`), route, id);
    assert.equal(router.resolveNavigationTarget(id), route, id);
    assert.equal(router.hashForRoute(route), `#${route}`, id);
  }
  for (const empty of ["", "#", "#/"]) assert.equal(router.parseHashRoute(empty), null, empty);
  assert.equal(router.parseHashRoute("#/unknown"), null);
  assert.equal(router.resolveNavigationTarget("unknown"), null);
});

test("[architecture] Store and window-manager facades and dependency ownership remain unchanged", async () => {
  const store = await import(moduleUrl("core/store.js"));
  const windowManager = await import(moduleUrl("core/window-manager.js"));
  assert.deepEqual(Object.keys(store), [
    "ACTION_TYPES",
    "DEFAULT_WINDOW_RECT",
    "UnknownActionError",
    "actionCreators",
    "createInitialState",
    "createStore",
    "rootReducer",
    "selectors",
  ]);
  assert.deepEqual(Object.keys(windowManager), ["createWindowManager", "deriveWindowViews"]);

  const instance = store.createStore({ initialState: store.createInitialState({ windows: [] }) });
  assert.deepEqual(store.selectors.windowStack(instance.getState()), []);
  assert.equal(store.selectors.focusedAppId(instance.getState()), null);
  instance.dispatch(store.actionCreators.windowOpened("crawl"));
  assert.deepEqual(store.selectors.windowStack(instance.getState()).map(({ appId, windowState }) => ({ appId, windowState })), [
    { appId: "crawl", windowState: "normal" },
  ]);
  assert.equal(store.selectors.focusedAppId(instance.getState()), "crawl");

  const storeClosure = [...dependencyClosure(resolve(JAVASCRIPT_ROOT, "core", "store.js"))].map(label);
  assert.deepEqual(
    storeClosure.filter((path) => path.startsWith("js/apps/") || /^js\/components\/.*-view\.js$/.test(path)),
    [],
  );
});

test("[API boundary] real applications preserve exported business endpoint snapshot and context.api exclusivity", async () => {
  const exportNames = {
    crawl: "CRAWL_ENDPOINTS",
    tasks: "TASKS_ENDPOINTS",
    proxy: "PROXY_ENDPOINTS",
    vault: "VAULT_ENDPOINTS",
    policy: "POLICY_ENDPOINTS",
    review: "REVIEW_ENDPOINTS",
    diagnostics: "DIAGNOSTICS_ENDPOINTS",
  };
  const actual = {};
  for (const [appId, exportName] of Object.entries(exportNames)) {
    const module = await import(moduleUrl(`apps/${appId}.js`));
    actual[appId] = module[exportName];
    assert.equal(Object.isFrozen(module[exportName]), true, `${appId} endpoint fact source`);
  }
  assert.deepEqual(actual, BUSINESS_ENDPOINT_SNAPSHOT);

  const bypasses = [];
  for (const [path, source] of JS_SOURCES) {
    if (path !== resolve(JAVASCRIPT_ROOT, "core", "api.js") && /\b(?:globalThis\.)?fetch\s*\(|\bXMLHttpRequest\b/.test(stripJavaScriptComments(source))) {
      bypasses.push(label(path));
    }
  }
  assert.deepEqual(bypasses, [], "context.api must remain the only business request outlet");
});

test("[preview boundary] Personalization and three preview closures own zero business APIs or production fixtures", () => {
  const violations = [];
  for (const appId of ["personalization", "gallery", "schedule", "export"]) {
    const entrypoint = resolve(JAVASCRIPT_ROOT, "apps", `${appId}.js`);
    const closure = [...dependencyClosure(entrypoint)];
    const relativeClosure = closure.map(label).sort();
    check(!closure.includes(resolve(JAVASCRIPT_ROOT, "core", "api.js")), `${appId} closure imports core/api.js`, violations);
    for (const path of closure) {
      const source = stripJavaScriptComments(JS_SOURCES.get(path));
      if (/\/(?:api|healthz|readyz)\b|\bcontext\.api\b|\{\s*api\s*[,}]/.test(source)) {
        violations.push(`${appId} closure has an API fact in ${label(path)}`);
      }
      if (/tests\/fixtures|fixtures\/webui|stage5-preview-fixtures|testsOnly/.test(source)) {
        violations.push(`${appId} closure reaches a tests-only fixture from ${label(path)}`);
      }
    }
    check(relativeClosure.some((path) => path === `js/apps/${appId}.js`), `${appId} closure lost its controller`, violations);
  }
  assertNoViolations("zero-API preview/personalization closure contract", violations);
});
