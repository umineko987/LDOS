mod backend;
mod process_tree;

use backend::{BackendManager, BackendStatus, RuntimeMetadata};
use tauri::{plugin::TauriPlugin, Manager, RunEvent, Runtime, State, Url};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn backend_status(manager: State<'_, BackendManager>) -> BackendStatus {
    manager.status()
}

#[tauri::command]
fn runtime_metadata(manager: State<'_, BackendManager>) -> Result<RuntimeMetadata, &'static str> {
    manager.metadata()
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
        .plugin(navigation_plugin())
        .invoke_handler(tauri::generate_handler![backend_status, runtime_metadata])
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
    fn tauri_uses_one_dist_and_declares_distribution_out_of_scope() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("valid Tauri config JSON");
        assert_eq!(config["build"]["frontendDist"], "../dist");
        assert_eq!(config["build"]["devUrl"], "http://localhost:1420");
        assert_eq!(config["bundle"]["active"], false);
        assert!(config["bundle"].get("externalBin").is_none());
        assert!(config["bundle"].get("resources").is_none());
        assert_eq!(
            config["app"]["security"]["capabilities"],
            serde_json::json!(["main"])
        );
    }
}
