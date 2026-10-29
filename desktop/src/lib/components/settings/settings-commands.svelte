<script lang="ts">
  import LicenseDialog from "#lib/components/model-install/license-dialog.svelte";
  import { useModelInstaller } from "#lib/components/model-install/installer.svelte.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { useBindings } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import type { Locale } from "#lib/paraglide/runtime.js";
  import { prefs } from "#lib/prefs/prefs.svelte.ts";

  // 命令面板里的设置动作（打开网络页是导航命令 nav.settings.network）。不渲染界面，
  // 只有安装缺失模型时可能弹出许可对话框。模型表在第一次执行时才拉，不在每页挂载时请求。
  const installer = useModelInstaller({ load: false });

  const LOCALES: Record<Locale, () => string> = { "zh-CN": m.prefs_language_zh_cn, en: m.prefs_language_en };
  const nextLocale = (): Locale => {
    const available = i18n.available;
    return available[(available.indexOf(i18n.current) + 1) % available.length]!;
  };

  const group = m.nav_settings;
  useBindings("global", () => [
    {
      id: "settings.models.install-missing",
      label: m.models_install_all,
      group,
      palette: true,
      keywords: ["models", "install", "moxing", "anzhuang"],
      run: () => void installer.installMissing(),
    },
    {
      id: "settings.prefs.motion",
      label: () => (prefs.reducedMotion ? m.prefs_command_motion_off() : m.prefs_command_motion_on()),
      group,
      palette: true,
      keywords: ["reduced motion", "animation", "dongxiao"],
      run: () => prefs.setMotion(prefs.reducedMotion ? "off" : "on"),
    },
    {
      id: "settings.prefs.density",
      label: () => (prefs.density === "compact" ? m.prefs_command_comfortable() : m.prefs_command_compact()),
      group,
      palette: true,
      keywords: ["density", "compact", "comfortable", "midu"],
      run: () => prefs.setDensity(prefs.density === "compact" ? "comfortable" : "compact"),
    },
    {
      id: "settings.prefs.language",
      label: () => m.prefs_command_language({ language: LOCALES[nextLocale()]() }),
      group,
      palette: true,
      keywords: ["language", "english", "chinese", "yuyan", "zhongwen"],
      run: () => i18n.set(nextLocale()),
    },
  ]);
</script>

<LicenseDialog {installer} />
