/** J/K、↑/↓ 在列表里移动选中项：没选中时从第一项（向下）或最后一项（向上）开始，到头不回绕。 */
export function stepSelection(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  if (index === -1) return delta === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, index + delta))]!;
}
