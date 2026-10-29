// 任务时长和「多久以前」的显示。时间单位都是秒（后端时间戳是 Unix 秒）。

/** 计时器样式：`0:42`、`12:03`、`1:02:03`。 */
export function formatElapsed(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** `3 分钟前` / `3 min. ago`。一分钟以内统一显示「刚刚」（由 `justNow` 给出当前语言的文案）。 */
export function formatAgo(seconds: number, locale: string, justNow: string): string {
  const age = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  for (const [unit, size] of UNITS) {
    if (age >= size) return format.format(-Math.floor(age / size), unit);
  }
  return justNow;
}

/** 绝对时间（列表里的创建时间等）；无效时间戳返回空串。 */
export function formatTimestamp(seconds: number | null, locale: string): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(seconds * 1000));
}
