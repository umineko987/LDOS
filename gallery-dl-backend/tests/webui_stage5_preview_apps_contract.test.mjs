import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const WEBUI = new URL("../gdl_backend/webui/", import.meta.url);
const REGISTRY_SOURCE = readFileSync(new URL("js/core/app-registry.js", WEBUI), "utf8");
const INDEX_SOURCE = readFileSync(new URL("index.html", WEBUI), "utf8");

const PREVIEW_APPS = Object.freeze(["gallery", "schedule", "export"]);

function sourceExists(path) {
  return existsSync(new URL(path, WEBUI));
}

test("Stage 5 registry uses three independent preview controllers instead of placeholders", () => {
  for (const appId of PREVIEW_APPS) {
    assert.match(
      REGISTRY_SOURCE,
      new RegExp(`import\\s+${appId}Application\\s+from\\s+["']\\.\\./apps/${appId}\\.js["']`),
      `${appId} must have an explicit production controller import`,
    );
    assert.doesNotMatch(
      REGISTRY_SOURCE,
      new RegExp(`\\[\\s*["']${appId}["'][^\\n]*createPlaceholderApplication`),
      `${appId} must not use createPlaceholderApplication`,
    );
  }
});

test("Stage 5 production model, view, controller, and stylesheet modules exist per app", () => {
  for (const appId of PREVIEW_APPS) {
    assert.equal(sourceExists(`js/apps/${appId}.js`), true, `${appId} controller is missing`);
    assert.equal(sourceExists(`js/core/${appId}-model.js`), true, `${appId} model is missing`);
    assert.equal(sourceExists(`js/components/${appId}-view.js`), true, `${appId} view is missing`);
    assert.equal(sourceExists(`styles/apps/${appId}.css`), true, `${appId} stylesheet is missing`);
  }
});

test("Stage 5 index explicitly loads all preview application styles", () => {
  for (const appId of PREVIEW_APPS) {
    assert.match(INDEX_SOURCE, new RegExp(`href=["']\\./styles/apps/${appId}\\.css["']`));
  }
});

test("Stage 5 preview production boundary declares no guessed business endpoints", () => {
  for (const appId of PREVIEW_APPS) {
    const paths = [
      `js/apps/${appId}.js`,
      `js/core/${appId}-model.js`,
      `js/components/${appId}-view.js`,
    ];
    for (const path of paths) {
      if (!sourceExists(path)) continue;
      const source = readFileSync(new URL(path, WEBUI), "utf8");
      assert.doesNotMatch(source, /\/api\//, `${path} must not declare a business API path`);
    }
  }
});
