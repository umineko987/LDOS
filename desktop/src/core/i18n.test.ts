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

  it("translates every supported dynamic UI shape", () => {
    const cases = [
      ["2 个当前显示 · 3 个已选", "2 currently shown · 3 selected"],
      ["4 个地址", "4 addresses"],
      ["夜航石墨：内置夜景", "Nocturne Graphite: Built-in night scene"],
      ["场景：夜航石墨（内置夜景）", "Scene: Nocturne Graphite (Built-in night scene)"],
      ["动效：界面动效已关闭", "Motion: Interface motion is disabled"],
      ["◆ 当前站点 · exhentai", "◆ Current site · exhentai"],
      ["显示 7 / 服务报告 8", "Showing 7 / 8 reported by the service"],
      ["订阅地址 · 2", "Subscription URLs · 2"],
      ["手动节点 · 3", "Manual nodes · 3"],
      ["等待 · batch-1", "Waiting · batch-1"],
      ["活动 · 运行中 · batch-1", "Active · Running · batch-1"],
      ["终态 · 成功 · batch-1", "Finished · Succeeded · batch-1"],
      ["当前筛选显示 2 / 最近 5 个批次。", "Current filter shows 2 / 5 recent batches."],
    ] as const;

    for (const [source, expected] of cases) {
      expect(translateUiText(source, "en")).toBe(expected);
    }
    expect(translateUiText("本地服务已连接 · custom", "en"))
      .toBe("Local service connected · custom");
    expect(translateUiText("  应用中心\n", "en")).toBe("  Application Center\n");
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
