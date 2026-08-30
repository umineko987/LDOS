import { beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";

import {
  language,
  setLanguage,
  toggleLanguage,
  translateCurrentUiText,
  translateUiText,
} from "./i18n";

describe("UI localization", () => {
  beforeEach(() => setLanguage("zh"));

  it("defaults to Chinese and toggles between both languages", () => {
    expect(get(language)).toBe("zh");
    toggleLanguage(get(language));
    expect(get(language)).toBe("en");
    toggleLanguage(get(language));
    expect(get(language)).toBe("zh");
  });

  it("translates shell, application, and dynamic status text", () => {
    expect(translateUiText("应用中心", "en")).toBe("Application Center");
    expect(translateUiText("图片采集", "en")).toBe("Image Collection");
    expect(translateUiText("来源与连接", "en")).toBe("Sources and connections");
    expect(translateUiText("搜索完成：12 个候选，3 个待核实结果。", "en"))
      .toBe("Search complete: 12 candidates, 3 results needing verification.");
    expect(translateUiText("图片采集", "zh")).toBe("图片采集");
  });

  it("preserves user content inside localized controls", () => {
    expect(translateUiText("E2E 导入目录", "en")).toBe("E2E 导入目录");
    expect(translateUiText("解除挂载 E2E 导入目录", "en")).toBe("Unmount E2E 导入目录");
  });

  it("uses the currently selected language for imperative UI", () => {
    setLanguage("en");
    expect(translateCurrentUiText("删除批次会递归删除批次下所有文件。\n\n确定删除这个批次吗？"))
      .toBe("Deleting the batch recursively deletes every file in it.\n\nDelete this batch?");
  });
});
