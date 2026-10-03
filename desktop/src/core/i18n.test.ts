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
      ["配色：夜航石墨", "Palette: Nocturne Graphite"],
      ["批次设置 · 并发 20 · 代理与输出目录", "Batch settings · concurrency 20 · Proxy and output folder"],
      ["来源进度汇总（2）", "Source progress summary (2)"],
      ["当前页错误分类（3 个任务）", "Error categories for this page (3 tasks)"],
      ["Pixiv 正等待授权浏览器操作。", "Pixiv is waiting for authorization browser interaction."],
      ["组 1 · 3 张图片", "Group 1 · 3 images"],
      ["组 24 · 1 张图片", "Group 24 · 1 image"],
      ["组 1 · 2/3 保留", "Group 1 · 2/3 kept"],
      ["组 24 · 1/1 保留 · 已采纳", "Group 24 · 1/1 kept · Adopted"],
      ["图 2 · 推荐项", "Image 2 · Recommended"],
      ["1 / 2 组已采纳", "1 / 2 groups adopted"],
      ["当前组 2 / 3 保留", "Current group 2 / 3 kept"],
    ] as const;

    for (const [source, expected] of cases) {
      expect(translateUiText(source, "en")).toBe(expected);
    }
    expect(translateUiText("本地服务已连接 · custom", "en"))
      .toBe("Local service connected · custom");
    expect(translateUiText("  应用中心\n", "en")).toBe("  Application Center\n");
  });

  it("translates compact-page status copy without reintroducing window wording", () => {
    expect(translateUiText("当前显示批次摘要与任务详情。", "en"))
      .toBe("Showing the batch summary and task details.");
    expect(translateUiText("部分检查失败；未更新的结果已标记为过期。", "en"))
      .toBe("Some checks failed. Results that were not updated are marked stale.");
    expect(translateUiText("操作完成并重新读取设置前，请勿离开此页。", "en"))
      .toBe("Do not leave this page until the action finishes and settings are refreshed.");
    expect(translateUiText("正在预览工作台配色，点击“应用”保存。", "en"))
      .toBe("Previewing the workbench palette. Select Apply to save.");
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
