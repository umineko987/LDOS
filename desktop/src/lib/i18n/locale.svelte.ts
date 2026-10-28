import { getLocale, locales, setLocale, type Locale } from "#lib/paraglide/runtime.js";

/**
 * 界面语言，作为响应式状态。
 *
 * Paraglide 把选择存进 localStorage（`ldos.locale`），启动时读取。切换不刷新页面：
 * 根布局用 `{#key i18n.current}` 重新渲染外壳，所有 `m.*()` 随之换成新语言，
 * 查询缓存和后端连接保留。
 */
class LocaleState {
  current = $state<Locale>(getLocale());

  readonly available: readonly Locale[] = locales;

  set(next: Locale): void {
    if (next === this.current) return;
    void setLocale(next, { reload: false });
    this.current = next;
    syncDocumentLang(next);
  }
}

export function syncDocumentLang(locale: Locale): void {
  document.documentElement.lang = locale;
}

export const i18n = new LocaleState();
