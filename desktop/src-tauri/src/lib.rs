mod backend;
#[cfg(any(not(debug_assertions), test))]
mod distribution;
mod process_tree;

use backend::{BackendManager, BackendStatus, RuntimeMetadata};
use tauri::{plugin::TauriPlugin, Manager, RunEvent, Runtime, State, Url};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn backend_status(manager: State<'_, BackendManager>) -> BackendStatus {
    manager.status()
}

#[tauri::command]
fn runtime_metadata(manager: State<'_, BackendManager>) -> Result<RuntimeMetadata, &'static str> {
    manager.metadata()
}

/// 窄平台能力（图库计划 §8.1）：只开放目录选择与结果定位，
/// 不开放任意读、写、删除或 shell。返回的绝对路径只允许进入
/// 前端短生命周期表单草稿与 write request（不进持久状态/日志）。
#[tauri::command]
async fn select_directory(app: tauri::AppHandle) -> Result<Option<String>, &'static str> {
    // 异步命令运行在后台线程池上，阻塞式目录对话框不会卡死主线程
    //（tauri-plugin-dialog 文档模式）。None 表示用户取消。
    match app.dialog().file().blocking_pick_folder() {
        None => Ok(None),
        Some(picked) => {
            let path = picked.into_path().map_err(|_| "dialog_path_unavailable")?;
            path.to_str()
                .map(|s| Some(s.to_owned()))
                .ok_or("dialog_path_not_utf8")
        }
    }
}

/// 在系统文件管理器中定位结果（只读“显示”，不读取内容进 WebView）。
#[tauri::command]
fn reveal_in_file_manager(app: tauri::AppHandle, path: String) -> Result<(), &'static str> {
    if path.is_empty() || path.contains('\u{0}') {
        return Err("invalid_reveal_path");
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|_| "reveal_failed")
}

fn navigation_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation")
        .on_navigation(|webview, url| {
            if allowed_navigation(url, cfg!(debug_assertions)) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
}

fn allowed_navigation(url: &Url, development: bool) -> bool {
    let production = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none());
    let vite = development
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(1420);
    production || vite
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.set_focus();
                    }
                }
            },
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(navigation_plugin())
        .invoke_handler(tauri::generate_handler![
            backend_status,
            runtime_metadata,
            select_directory,
            reveal_in_file_manager
        ])
        .setup(|app| {
            let manager = BackendManager::new();
            app.manage(manager.clone());
            manager.start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build ImageWeave desktop host");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            if let Some(manager) = app.try_state::<BackendManager>() {
                manager.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_is_exact_and_external_http_never_replaces_the_app() {
        for allowed in ["tauri://localhost/", "http://tauri.localhost/asset.js"] {
            assert!(allowed_navigation(
                &Url::parse(allowed).expect("allowed URL"),
                false
            ));
        }
        assert!(allowed_navigation(
            &Url::parse("http://localhost:1420/src/main.ts").expect("Vite URL"),
            true,
        ));
        for denied in [
            "https://example.com/",
            "http://127.0.0.1:8787/healthz",
            "http://localhost:1421/",
            "file:///tmp/private",
            "tauri://evil.example/",
        ] {
            assert!(!allowed_navigation(
                &Url::parse(denied).expect("denied URL"),
                false
            ));
        }
        assert!(!allowed_navigation(
            &Url::parse("http://localhost:1420/").expect("production-denied Vite URL"),
            false,
        ));
    }

    #[test]
    fn capability_exposes_only_scoped_external_url_opening() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json"))
                .expect("valid capability JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("capability permissions");
        assert_eq!(
            permissions,
            &["opener:allow-open-url", "opener:allow-default-urls",]
        );
        let serialized = serde_json::to_string(permissions).expect("serialize permissions");
        for forbidden in ["shell", "process", "fs:", "path", "open-path"] {
            assert!(!serialized.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn tauri_bundles_one_frontend_and_one_controlled_backend() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("valid Tauri config JSON");
        assert_eq!(config["build"]["frontendDist"], "../dist");
        assert_eq!(config["build"]["devUrl"], "http://localhost:1420");
        assert_eq!(config["bundle"]["active"], false);
        assert!(config["bundle"].get("externalBin").is_none());
        assert!(config["bundle"].get("resources").is_none());
        assert!(config["build"].get("beforeBundleCommand").is_none());
        let release: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.release.conf.json"))
                .expect("valid release Tauri config JSON");
        assert_eq!(release["bundle"]["active"], true);
        assert_eq!(
            release["bundle"]["resources"],
            serde_json::json!({
                "release/backend/": "backend/",
                "../../gallery-dl-backend/gdl_backend/webui_dist/frontend-manifest.json":
                    "frontend-manifest.json"
            })
        );
        assert_eq!(
            release["build"]["beforeBundleCommand"]["script"],
            "python ../../scripts/desktop_release.py verify-tree --tree release/backend"
        );
        assert_eq!(config["identifier"], "dev.imageweave.desktop");
        let linux: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.linux.conf.json"))
                .expect("valid Linux Tauri config JSON");
        let windows: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.windows.conf.json"))
                .expect("valid Windows Tauri config JSON");
        assert_eq!(
            linux["bundle"]["targets"],
            serde_json::json!(["deb", "appimage"])
        );
        assert_eq!(windows["bundle"]["targets"], serde_json::json!(["nsis"]));
        assert_eq!(
            windows["bundle"]["windows"]["nsis"]["installMode"],
            "currentUser"
        );
        assert_eq!(config["app"]["windows"][0]["decorations"], true);
        assert_eq!(config["app"]["windows"][0]["dataDirectory"], "webview");
        assert_eq!(
            config["app"]["security"]["capabilities"],
            serde_json::json!(["main"])
        );
    }
}
