// 把清洗 / 去重接口的数据变成分诊状态机（#lib/keys/triage.ts）的分组，以及反方向：把保留集合变成定夺请求。
//
// - 清洗：后端每张命中的图自己一组。页面按 CLEAN_BATCH 张一批放进卡组，一批就是状态机里的一组，
//   Enter 一次提交这一批里的每张图（保留 → keep [id]，移除 → keep []）。
// - 去重：一组近似重复就是状态机里的一组；推荐项预选为保留。自动组（精确 / 压缩重复）不进卡组，单独列出。

import type { CleanItem, DedupGroup, TriageGroupDecision, TriageMember } from "#lib/api/queries/triage.ts";
import type { TriageGroupInit } from "#lib/keys/triage.ts";

/** 清洗卡组一批几张（1–9 键够用；CLEAN_PAGE_SIZE 200 是它的整数倍，翻页不会拆开一批）。 */
export const CLEAN_BATCH = 8;

/** 一张图现在算不算保留：已落地看 disposition，还没落地看审核的勾选。 */
export function memberKept(member: Pick<TriageMember, "disposition" | "selected">): boolean {
  return member.disposition === "kept" || (member.disposition === "pending" && member.selected);
}

export interface CleanBatch extends TriageGroupInit {
  readonly members: readonly CleanItem[];
}

export function cleanBatches(items: readonly CleanItem[], size = CLEAN_BATCH): CleanBatch[] {
  const step = Math.max(1, Math.floor(size));
  const batches: CleanBatch[] = [];
  for (let start = 0; start < items.length; start += step) {
    const members = items.slice(start, start + step);
    const kept = members.filter(memberKept).map((member) => member.asset_id);
    batches.push({
      // 第一张图的 id：列表顺序固定（按审核里的组序），同一批跨翻页、重新拉取都不变。
      id: `batch:${members[0]!.asset_id}`,
      items: members.map((member) => member.asset_id),
      suggested: kept,
      decided: members.every((member) => member.decided) ? kept : null,
      minKeep: 0,
      members,
    });
  }
  return batches;
}

/** 一批的定夺：每张图自己一组。 */
export function cleanDecisions(batch: Pick<CleanBatch, "members">, keep: Iterable<string>): TriageGroupDecision[] {
  const kept = new Set(keep);
  return batch.members.map((member) => ({ group_id: member.group_id, keep: kept.has(member.asset_id) ? [member.asset_id] : [] }));
}

export function dedupGroupInit(group: DedupGroup): TriageGroupInit {
  const suggested = group.suggested_keep.length
    ? group.suggested_keep
    : group.members.filter((member) => member.selected).map((member) => member.asset_id);
  return {
    id: group.group_id,
    items: group.members.map((member) => member.asset_id),
    suggested,
    decided: group.decided ? group.members.filter(memberKept).map((member) => member.asset_id) : null,
    // 近似重复至少留一张；不可读的组可以全移除。
    minKeep: group.kind === "duplicate" ? 1 : 0,
  };
}

export function dedupDecisions(group: string, keep: Iterable<string>): TriageGroupDecision[] {
  return [{ group_id: group, keep: [...keep] }];
}

/**
 * 自动组只含被回收的图（保留的那张是 winner_asset_id，不在组里）。恢复其中一张 = 重新定夺这一组，
 * keep 里放上已经恢复过的和这一张。
 */
export function restoreDecision(group: DedupGroup, assetId: string): TriageGroupDecision {
  const keep = group.members.filter((member) => member.disposition === "kept").map((member) => member.asset_id);
  return { group_id: group.group_id, keep: keep.includes(assetId) ? keep : [...keep, assetId] };
}

/** 去重卡组里的组（非自动）和自动组分开。 */
export function splitDedupGroups(groups: readonly DedupGroup[]): { manual: DedupGroup[]; automatic: DedupGroup[] } {
  const manual: DedupGroup[] = [];
  const automatic: DedupGroup[] = [];
  for (const group of groups) (group.automatic ? automatic : manual).push(group);
  return { manual, automatic };
}
