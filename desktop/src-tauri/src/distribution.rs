use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

const RESOURCE_ENV: &str = "LDOS_DESKTOP_RESOURCE_ROOT";
const DATA_ENV: &str = "LDOS_DESKTOP_DATA_ROOT";
const PYTHON_ENV: &str = "LDOS_DESKTOP_PYTHON";

fn packaged_backend_root(resource_dir: &Path) -> PathBuf {
    let standard = resource_dir.join("backend");
    if standard.join("release-manifest.json").is_file() {
        return standard;
    }

    let appimage = resource_dir
        .parent()
        .and_then(Path::parent)
        .map(|usr| usr.join("share/LDOS/backend"));
    if let Some(appimage) = appimage {
        if appimage.join("release-manifest.json").is_file() {
            return appimage;
        }
    }
    standard
}

#[derive(Clone, Debug)]
pub struct BackendDistribution {
    pub backend_root: PathBuf,
    pub data_root: PathBuf,
    pub config_path: PathBuf,
    pub python_executable: PathBuf,
}

impl BackendDistribution {
    pub fn prepare(resource_dir: &Path, config_dir: &Path, data_dir: &Path) -> io::Result<Self> {
        let backend_root = packaged_backend_root(resource_dir);
        let app_root = backend_root.join("app");
        let python_executable = backend_root
            .join("runtime")
            .join("python")
            .join("bin/python3.13");
        let required = [
            python_executable.clone(),
            app_root.join("gdl_backend/__init__.py"),
            app_root.join("gallery-dl-codeberg/gallery_dl/__init__.py"),
            app_root.join("dedup_review_worker.py"),
            app_root.join("dedup_core.py"),
            backend_root.join("release-manifest.json"),
        ];
        for path in required {
            if !path.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("packaged backend resource is missing: {}", path.display()),
                ));
            }
        }

        create_private_directory(config_dir)?;
        create_private_directory(data_dir)?;
        let config_path = config_dir.join("backend.json");
        if !config_path.exists() {
            write_initial_config(&config_path, &backend_root, data_dir, &python_executable)?;
        }

        Ok(Self {
            backend_root,
            data_root: data_dir.to_path_buf(),
            config_path,
            python_executable,
        })
    }

    pub fn environment(&self) -> [(OsString, OsString); 3] {
        [
            (
                OsString::from(RESOURCE_ENV),
                self.backend_root.clone().into(),
            ),
            (OsString::from(DATA_ENV), self.data_root.clone().into()),
            (
                OsString::from(PYTHON_ENV),
                self.python_executable.clone().into(),
            ),
        ]
    }
}

fn write_initial_config(
    config_path: &Path,
    backend_root: &Path,
    data_root: &Path,
    python: &Path,
) -> io::Result<()> {
    let app_root = backend_root.join("app");
    let runtime_dir = data_root.join("runtime");
    let output_dir = data_root.join("downloads");
    let credentials_dir = data_root.join("credentials");
    let subscriptions_dir = data_root.join("subscriptions");
    let config = serde_json::json!({
        "runtime_dir": runtime_dir,
        "database_path": runtime_dir.join("backend.sqlite3"),
        "default_output_root": output_dir,
        "allowed_output_roots": [output_dir],
        "allowed_config_roots": [credentials_dir],
        "allowed_cookie_roots": [credentials_dir],
        "server": {
            "host": "127.0.0.1",
            "port": 8787,
            "cors_origins": ["tauri://localhost", "http://tauri.localhost"],
            "allow_private_targets": false,
            "strict_target_dns": true
        },
        "gallery": {
            "repo_path": app_root.join("gallery-dl-codeberg"),
            "cache_file": data_root.join("credentials/managed/gallery-dl-cache.sqlite3"),
            "python_executable": python,
            "migrate_default_auth": false
        },
        "auth": {
            "chrome_executable": "",
            "authorization_proxy": ""
        },
        "proxy": {
            "enabled": false,
            "auto_start": false,
            "engine": "native",
            "subscription_urls": [],
            "inline_nodes": [],
            "allowed_node_roots": [subscriptions_dir],
            "transport_core_enabled": false
        },
        "dedup": {
            "enabled": false,
            "python_executable": python,
            "worker_script": app_root.join("dedup_review_worker.py"),
            "core_script": app_root.join("dedup_core.py"),
            "model_dir": data_root.join("models"),
            "device": "auto"
        }
    });
    let bytes = serde_json::to_vec_pretty(&config).map_err(io::Error::other)?;
    let temporary = config_path.with_extension(format!("json.tmp-{}", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> io::Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, config_path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ldos-distribution-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn fake_resources(root: &Path) {
        let backend = root.join("backend");
        for path in [
            backend.join("runtime/python/bin/python3.13"),
            backend.join("app/gdl_backend/__init__.py"),
            backend.join("app/gallery-dl-codeberg/gallery_dl/__init__.py"),
            backend.join("app/dedup_review_worker.py"),
            backend.join("app/dedup_core.py"),
            backend.join("release-manifest.json"),
        ] {
            fs::create_dir_all(path.parent().expect("resource parent")).expect("resource dir");
            fs::write(path, b"fixture").expect("resource file");
        }
    }

    #[test]
    fn first_launch_uses_one_runtime_and_stable_writable_roots() {
        let root = test_root("first-launch");
        let resources = root.join("resources");
        let config = root.join("config");
        let data = root.join("data");
        fake_resources(&resources);

        let distribution =
            BackendDistribution::prepare(&resources, &config, &data).expect("prepare distribution");
        assert_eq!(distribution.backend_root, resources.join("backend"));
        assert_eq!(distribution.data_root, data);
        let environment = distribution.environment();
        assert!(environment.iter().any(|(name, value)| {
            name == RESOURCE_ENV && value == distribution.backend_root.as_os_str()
        }));
        assert!(environment.iter().any(|(name, value)| {
            name == DATA_ENV && value == distribution.data_root.as_os_str()
        }));
        assert!(environment.iter().any(|(name, value)| {
            name == PYTHON_ENV && value == distribution.python_executable.as_os_str()
        }));
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&distribution.config_path).expect("read config"))
                .expect("parse config");
        assert_eq!(
            document["gallery"]["python_executable"],
            document["dedup"]["python_executable"]
        );
        assert_eq!(
            document["gallery"]["python_executable"],
            distribution.python_executable.to_string_lossy().as_ref()
        );
        assert_eq!(
            document["runtime_dir"],
            data.join("runtime").to_string_lossy().as_ref()
        );
        assert_eq!(document["proxy"]["enabled"], false);
        assert_eq!(document["dedup"]["enabled"], false);
        let serialized = document.to_string();
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("password"));

        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&distribution.config_path)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(root).expect("clean fixture");
    }

    #[cfg(unix)]
    #[test]
    fn appimage_uses_backend_payload_outside_usr_lib() {
        let root = test_root("appimage-backend");
        let resource_dir = root.join("usr/lib/LDOS");
        let appimage_root = root.join("usr/share/LDOS");
        let config = root.join("config");
        let data = root.join("data");
        fake_resources(&appimage_root);

        let distribution = BackendDistribution::prepare(&resource_dir, &config, &data)
            .expect("prepare AppImage distribution");
        assert_eq!(distribution.backend_root, appimage_root.join("backend"),);
        assert_eq!(
            distribution.python_executable,
            appimage_root.join("backend/runtime/python/bin/python3.13"),
        );
        fs::remove_dir_all(root).expect("clean fixture");
    }

    #[test]
    fn existing_user_config_is_never_overwritten() {
        let root = test_root("existing-config");
        let resources = root.join("resources");
        let config = root.join("config");
        let data = root.join("data");
        fake_resources(&resources);
        fs::create_dir_all(&config).expect("config dir");
        fs::write(config.join("backend.json"), b"{\"user\":true}\n").expect("user config");

        let distribution =
            BackendDistribution::prepare(&resources, &config, &data).expect("prepare distribution");
        assert_eq!(
            fs::read(&distribution.config_path).expect("read user config"),
            b"{\"user\":true}\n"
        );
        assert!(distribution.python_executable.ends_with("bin/python3.13"));
        fs::remove_dir_all(root).expect("clean fixture");
    }

    #[test]
    fn incomplete_resource_tree_fails_closed() {
        let root = test_root("missing-resource");
        let error = BackendDistribution::prepare(
            &root.join("resources"),
            &root.join("config"),
            &root.join("data"),
        )
        .expect_err("missing resources must fail");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
