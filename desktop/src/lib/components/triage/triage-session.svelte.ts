// 清洗 / 去重页共用的分诊会话：把纯状态机（#lib/keys/triage.ts）接到接口上。
//
//   const session = new TriageSession({
//     api, client, id: () => id, stage: "dedup",
//     runId: () => summary.data?.run?.run_id ?? null,
//     groups: () => deckGroups,                 // TriageGroupInit[]，随查询数据变化
//     key: () => runId,                         // 变了就从服务器数据重建（换了运行、换了筛选）
//     decisions: (group, keep) => dedupDecisions(group, keep),
//     serverUndoDepth: () => summary.data?.undo_depth ?? 0,
//   });
//   session.state                               // TriageState（$state.raw）
//   session.dispatch({ type: "toggle", index }) // 本地操作
//   session.adopt()                             // Enter：定夺当前组并提交
//   session.undo()                              // Z：本地编辑就地撤销；定夺按批次请求后端撤销
//   session.external(decisions, label)          // 卡组外的定夺（恢复自动组里的一张），也进 Z 的历史
//
// 提交按顺序排队，一次一个；撤销等前面的提交都回来再发，只撤最近一批（后端也只允许撤最近一批）。
// 只能在组件初始化时创建（内部有 $effect）。

import type { QueryClient } from "@tanstack/svelte-query";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";

import type { Api } from "#lib/api/client.ts";
import { isApiError } from "#lib/api/errors.ts";
import { apiErrorMessage } from "#lib/api/messages.ts";
import {
  applyTriage,
  invalidateTriage,
  refreshAfterTriage,
  triageKeys,
  undoTriage,
  type StageTriageSummary,
  type TriageGroupDecision,
  type TriageStage,
} from "#lib/api/queries/triage.ts";
import {
  adoptPlan,
  createTriage,
  lastEntry,
  triageReducer,
  type TriageAction,
  type TriageGroupInit,
  type TriageState,
} from "#lib/keys/triage.ts";
import { m } from "#lib/paraglide/messages.js";

export interface TriageSessionOptions {
  readonly api: Api;
  readonly client: QueryClient;
  readonly id: () => string;
  readonly stage: TriageStage;
  readonly runId: () => string | null;
  readonly groups: () => readonly TriageGroupInit[];
  /** 状态机的身份：变了就丢掉本地状态，按服务器数据重建。 */
  readonly key: () => string;
  /** 一组的保留集合 → 定夺请求（清洗一批是多组，去重一组就是一组）。 */
  readonly decisions: (group: string, keep: readonly string[]) => TriageGroupDecision[];
  /** 后端撤销栈的深度（summary.undo_depth）；本地没有历史时 Z 撤后端最近一批。 */
  readonly serverUndoDepth: () => number;
  readonly minKeep?: number;
}

/** 后端已经撤不了这一批（重启过、被别处的定夺压住了）：本地也不再记它。 */
const STALE_UNDO = new Set(["triage_nothing_to_undo", "triage_undo_not_latest"]);

export class TriageSession {
  state = $state.raw<TriageState>(createTriage([]));
  /** 正在提交的定夺数。 */
  pending = $state(0);
  /** 撤销请求在路上：按键暂停，免得在旧状态上继续操作。 */
  undoing = $state(false);

  readonly #options: TriageSessionOptions;
  /** 历史条目 id → 后端批次 id。 */
  readonly #batches = new Map<number, string>();
  #queue: Promise<void> = Promise.resolve();
  #key: string | null = null;

  constructor(options: TriageSessionOptions) {
    this.#options = options;
    this.#rebuild(untrack(options.key), untrack(options.groups));
    $effect(() => {
      const key = options.key();
      const groups = options.groups();
      untrack(() => {
        if (key !== this.#key) this.#rebuild(key, groups);
        else this.dispatch({ type: "load", groups });
      });
    });
  }

  get busy(): boolean {
    return this.pending > 0 || this.undoing;
  }

  dispatch(action: TriageAction): void {
    this.state = triageReducer(this.state, action);
  }

  /** 丢掉本地状态和历史，按当前的服务器数据重建（部分失败之后对账用）。 */
  reset(): void {
    this.#rebuild(untrack(this.#options.key), untrack(this.#options.groups));
  }

  #rebuild(key: string, groups: readonly TriageGroupInit[]): void {
    this.#key = key;
    this.#batches.clear();
    // 条目 id 跨重建继续递增：排队中的提交拿着旧 id，不能撞上新条目。
    this.state = { ...createTriage(groups, { minKeep: this.#options.minKeep }), seq: this.state.seq };
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    this.pending += 1;
    const run = this.#queue.then(task).finally(() => {
      this.pending -= 1;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #storeSummary(summary: StageTriageSummary): void {
    const { client, id, stage } = this.#options;
    client.setQueryData(triageKeys.summary(id(), stage), summary);
  }

  /** 后端说运行已经换了、失效了：重拉分诊，页面跟着显示新状态。 */
  #onFailure(error: unknown): void {
    const { client, id, stage } = this.#options;
    toast.error(m.triage_apply_failed({ reason: apiErrorMessage(error) }));
    void invalidateTriage(client, id(), stage);
  }

  /** Enter：定夺当前组，焦点立即前进；提交失败时把这一组恢复成定夺前。 */
  adopt(): void {
    if (this.undoing) return;
    const plan = adoptPlan(this.state);
    this.dispatch({ type: "adopt" });
    if (!plan) return;
    const entry = lastEntry(this.state)!.id;
    void this.#submit(entry, this.#options.decisions(plan.group, plan.keep), true);
  }

  /** 卡组外的定夺：压一个 mark 条目，让 Z 的顺序和后端批次一致。 */
  external(decisions: TriageGroupDecision[], label?: string): Promise<void> {
    this.dispatch({ type: "mark", label });
    return this.#submit(lastEntry(this.state)!.id, decisions, false);
  }

  #submit(entry: number, groups: TriageGroupDecision[], revertible: boolean): Promise<void> {
    const { api, client, id, stage, runId } = this.#options;
    const dataset = id();
    const drop = () => this.dispatch(revertible ? { type: "revert", entry } : { type: "forget", entry });
    return this.#enqueue(async () => {
      const run = runId();
      if (!run) {
        drop();
        return;
      }
      try {
        const result = await applyTriage(api, dataset, stage, { run_id: run, groups });
        this.#storeSummary(result.summary);
        if (result.batch_id) {
          this.#batches.set(entry, result.batch_id);
          const undo = { label: m.triage_undo(), onClick: () => void this.undoEntry(entry) };
          toast(m.triage_applied({ kept: result.kept.length, rejected: result.rejected.length }), { action: undo });
        } else {
          drop();
        }
        if (result.error) toast.error(m.triage_apply_partial({ reason: result.error.message }));
        if (result.failed.length) toast.error(m.triage_failed_assets({ count: result.failed.length }));
        await refreshAfterTriage(client, dataset, result);
        // 一批里有组没落地：本地以为都定夺了，按服务器数据重来。
        if (result.error && result.batch_id) this.reset();
      } catch (error) {
        drop();
        this.#onFailure(error);
      }
    });
  }

  /** Z：最近一步是本地编辑就地撤销；是定夺就请求后端撤销那一批；本地没有历史时撤后端最近一批。 */
  undo(): void {
    if (this.undoing) return;
    const top = lastEntry(this.state);
    if (top?.kind === "edit") {
      this.dispatch({ type: "undo" });
      return;
    }
    if (top) {
      void this.undoEntry(top.id);
      return;
    }
    if (this.pending === 0 && this.#options.serverUndoDepth() > 0) void this.#undoServer();
  }

  /** 撤销某一步（Toast 上的“撤销”）：只有它还是最近一步时才撤。 */
  async undoEntry(entry: number): Promise<void> {
    if (this.undoing) return;
    this.undoing = true;
    try {
      await this.#queue;
      const top = lastEntry(this.state);
      if (top?.id !== entry) {
        // 提交失败已经撤回了这一步，或者后面又有了别的操作。
        if (this.state.history.some((item) => item.id === entry)) toast.error(m.triage_undo_not_latest());
        return;
      }
      if (top.kind === "edit") {
        this.dispatch({ type: "undo", entry });
        return;
      }
      const batch = this.#batches.get(entry);
      if (!batch) {
        this.dispatch({ type: "forget", entry });
        return;
      }
      await this.#undoBatch(batch, () => {
        this.#batches.delete(entry);
        this.dispatch({ type: "undo", entry });
      }, () => this.dispatch({ type: "forget", entry }));
    } finally {
      this.undoing = false;
    }
  }

  async #undoServer(): Promise<void> {
    this.undoing = true;
    try {
      await this.#undoBatch(null, () => undefined, () => undefined, true);
    } finally {
      this.undoing = false;
    }
  }

  async #undoBatch(batch: string | null, done: () => void, stale: () => void, rebuild = false): Promise<void> {
    const { api, client, id, stage } = this.#options;
    const dataset = id();
    try {
      const result = await undoTriage(api, dataset, stage, batch);
      this.#storeSummary(result.summary);
      if (!rebuild) done();
      toast(m.triage_undone({ count: result.undone_groups }));
      if (result.error) toast.error(m.triage_undo_failed({ reason: result.error.message }));
      await refreshAfterTriage(client, dataset, result);
      // 没有本地历史可对，或者只撤了一部分：按服务器数据重来。
      if (rebuild || result.error) this.reset();
    } catch (error) {
      if (isApiError(error) && STALE_UNDO.has(error.code)) stale();
      toast.error(m.triage_undo_failed({ reason: apiErrorMessage(error) }));
      void invalidateTriage(client, dataset, stage);
    }
  }
}
