import { describe, expect, it } from "vitest";

import type { DatasetExport, ExportOptions, ExportPlan } from "#lib/api/queries/exports.ts";
import type { Job } from "#lib/api/queries/jobs.ts";

import {
  captionSample,
  EXPORT_REPEATS_DEFAULT,
  exportFormDefaults,
  exportFormIssue,
  exportProgress,
  exportRequest,
  folderHint,
  isAbsolutePath,
  parseTagList,
  planRows,
  safeFolderName,
  type ExportForm,
} from "./export-plan.ts";

const LAST: ExportOptions = {
  target_path: "/out",
  layout: "flat",
  repeats: 4,
  trigger_word: "old",
  folder_name: "4_old",
  rename: "sequential",
  include_captions: false,
  pin_trigger: false,
  tag_blacklist: ["a", "b"],
  underscore_to_space: true,
};

const form = (overrides: Partial<ExportForm> = {}): ExportForm => ({ ...exportFormDefaults("miku"), target: "/out", ...overrides });

describe("exportFormDefaults", () => {
  it("没有历史：kohya、10 次、带标注、触发词置顶", () => {
    expect(exportFormDefaults(" miku ")).toEqual({
      target: "",
      layout: "kohya",
      repeats: EXPORT_REPEATS_DEFAULT,
      trigger: "miku",
      folder: "",
      rename: "none",
      captions: true,
      pinTrigger: true,
      blacklist: "",
      underscores: false,
    });
  });

  it("沿用上一次的选项，但不沿用算出来的文件夹名；数据集有触发词时用数据集的", () => {
    expect(exportFormDefaults("miku", LAST)).toEqual({
      target: "/out",
      layout: "flat",
      repeats: 4,
      trigger: "miku",
      folder: "",
      rename: "sequential",
      captions: false,
      pinTrigger: false,
      blacklist: "a, b",
      underscores: true,
    });
    expect(exportFormDefaults("", LAST).trigger).toBe("old");
  });
});

describe("parseTagList / isAbsolutePath", () => {
  it("逗号换行都能分隔，去空项，按小写去重", () => {
    expect(parseTagList(" a, b\nA,, c\r\n")).toEqual(["a", "b", "c"]);
    expect(parseTagList("")).toEqual([]);
  });

  it("三种绝对路径", () => {
    expect(isAbsolutePath("/home/x")).toBe(true);
    expect(isAbsolutePath("C:\\out")).toBe(true);
    expect(isAbsolutePath("d:/out")).toBe(true);
    expect(isAbsolutePath("\\\\nas\\share")).toBe(true);
    expect(isAbsolutePath("out")).toBe(false);
    expect(isAbsolutePath("C:out")).toBe(false);
    expect(isAbsolutePath("\\\\")).toBe(false);
  });
});

describe("exportFormIssue", () => {
  it("目录必填、必须是绝对路径", () => {
    expect(exportFormIssue(form({ target: "  " }))).toBe("target_required");
    expect(exportFormIssue(form({ target: "rel/path" }))).toBe("target_not_absolute");
    expect(exportFormIssue(form())).toBeNull();
  });

  it("kohya 要触发词或文件夹名、repeats 在范围内；flat 都不要", () => {
    expect(exportFormIssue(form({ trigger: " " }))).toBe("trigger_required");
    expect(exportFormIssue(form({ trigger: "", folder: "custom" }))).toBeNull();
    expect(exportFormIssue(form({ repeats: 0 }))).toBe("repeats_invalid");
    expect(exportFormIssue(form({ repeats: 10_001 }))).toBe("repeats_invalid");
    expect(exportFormIssue(form({ repeats: 1.5 }))).toBe("repeats_invalid");
    expect(exportFormIssue(form({ layout: "flat", trigger: "", repeats: 0 }))).toBeNull();
  });
});

describe("exportRequest", () => {
  it("修整文本、解析黑名单、空文件夹名发 null", () => {
    expect(exportRequest(form({ target: " /out ", trigger: " miku ", blacklist: "x, y", repeats: 3 }))).toEqual({
      target_path: "/out",
      layout: "kohya",
      repeats: 3,
      trigger_word: "miku",
      folder_name: null,
      rename: "none",
      include_captions: true,
      pin_trigger: true,
      tag_blacklist: ["x", "y"],
      underscore_to_space: false,
    });
  });

  it("flat 发默认 repeats；自定义文件夹名原样发", () => {
    expect(exportRequest(form({ layout: "flat", repeats: 0, folder: " set " }))).toMatchObject({ repeats: EXPORT_REPEATS_DEFAULT, folder_name: "set" });
  });
});

describe("文件夹名", () => {
  it("safeFolderName 和后端规则一致", () => {
    expect(safeFolderName('a<b>:c"d/e\\f|g?h*i')).toBe("a_b__c_d_e_f_g_h_i");
    expect(safeFolderName("  hello   world. ")).toBe("hello world");
    expect(safeFolderName("...")).toBe("dataset");
    expect(safeFolderName("CON")).toBe("CON_");
    expect(safeFolderName("com3.txt")).toBe("com3.txt_");
    expect(safeFolderName("x".repeat(130) + " y")).toHaveLength(120);
  });

  it("kohya 是 repeats_触发词或自定义名；flat 是自定义名或数据集名", () => {
    expect(folderHint(form({ repeats: 5, trigger: "a/b" }), "set")).toBe("5_a_b");
    expect(folderHint(form({ repeats: 5, folder: "own" }), "set")).toBe("5_own");
    expect(folderHint(form({ trigger: "" }), "set")).toBeNull();
    expect(folderHint(form({ layout: "flat" }), "my set.")).toBe("my set");
    expect(folderHint(form({ layout: "flat", folder: "own" }), "set")).toBe("own");
  });
});

const PLAN: ExportPlan = {
  dataset_id: "d1",
  layout: "kohya",
  folder_name: "10_miku",
  target_path: "/out",
  output_path: "/out/10_miku",
  target_exists: false,
  options: LAST,
  image_count: 3,
  caption_count: 1,
  image_bytes: 300,
  txt_bytes: 10,
  total_bytes: 310,
  collision_count: 0,
  collisions: [],
  blockers: [],
  items: [
    { asset_id: "a", name: "a.png", source_relative_path: "a.png", output_relative_path: "0001.png", caption_output_relative_path: "0001.txt", caption_preview: "miku, smile", size_bytes: 100 },
    { asset_id: "b", name: "b.png", source_relative_path: "b.png", output_relative_path: "b.png", caption_output_relative_path: null, caption_preview: "", size_bytes: 200 },
  ],
};

describe("计划树", () => {
  it("文件夹、图片、标注；没列出的张数", () => {
    const { rows, more } = planRows(PLAN);
    expect(rows.map((row) => `${row.kind}:${row.path}`)).toEqual(["folder:10_miku/", "image:0001.png", "caption:0001.txt", "image:b.png"]);
    expect(rows[1]).toMatchObject({ source: "a.png", size: 100, renamed: true });
    expect(rows[3]).toMatchObject({ renamed: false });
    expect(rows[2]).toMatchObject({ preview: "miku, smile" });
    expect(more).toBe(1);
    expect(planRows({ ...PLAN, image_count: 0, items: [] }).more).toBe(0);
  });

  it("标注样例取第一条非空的", () => {
    expect(captionSample(PLAN)).toBe("miku, smile");
    expect(captionSample({ ...PLAN, items: [PLAN.items[1]!] })).toBeNull();
  });
});

const record = (overrides: Partial<DatasetExport> = {}) => ({ status: "running", staged_items: 1, total_items: 4, ...overrides }) as DatasetExport;
const job = (overrides: Partial<Job> = {}) => ({ id: "j", current: 3, total: 4, ...overrides }) as Job;

describe("exportProgress", () => {
  it("有实时任务时看任务，否则看记录", () => {
    expect(exportProgress(record(), job())).toEqual({ done: 3, total: 4, fraction: 0.75 });
    expect(exportProgress(record(), job({ current: null }))).toEqual({ done: 0, total: 4, fraction: 0 });
    expect(exportProgress(record(), job({ total: null }))).toEqual({ done: 1, total: 4, fraction: 0.25 });
    expect(exportProgress(record())).toEqual({ done: 1, total: 4, fraction: 0.25 });
  });

  it("成功就是满格；总数为 0 时不定进度", () => {
    expect(exportProgress(record({ status: "succeeded", staged_items: 2 }))).toEqual({ done: 4, total: 4, fraction: 1 });
    expect(exportProgress(record({ total_items: 0, staged_items: 0 }))).toEqual({ done: 0, total: 0, fraction: null });
    expect(exportProgress(record({ staged_items: 9 })).fraction).toBe(1);
  });
});
