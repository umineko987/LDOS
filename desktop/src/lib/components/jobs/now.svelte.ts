// 每秒走一次的时钟（秒，带小数），给运行时长和「几分钟前」用。`active()` 为假时停表，不空转。

export function useNow(active: () => boolean = () => true): { readonly seconds: number } {
  let seconds = $state(Date.now() / 1000);
  $effect(() => {
    if (!active()) return;
    seconds = Date.now() / 1000;
    const timer = setInterval(() => (seconds = Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  });
  return {
    get seconds() {
      return seconds;
    },
  };
}
