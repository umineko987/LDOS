use std::{
    env,
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[cfg(not(debug_assertions))]
use crate::distribution::BackendDistribution;
use crate::process_tree::ProcessTree;

pub const HEALTH_PATH: &str = "/healthz";
const VERSION_PATH: &str = "/";
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_HTTP_BYTES: u64 = 64 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(30);
const PROBE_INTERVAL: Duration = Duration::from_millis(100);
const MONITOR_INTERVAL: Duration = Duration::from_millis(250);
const IO_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetadata {
    api_origin: String,
    backend_version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendState {
    Starting,
    Ready,
    Failed,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct BackendStatus {
    state: BackendState,
    code: Option<&'static str>,
}

impl BackendStatus {
    fn starting() -> Self {
        Self {
            state: BackendState::Starting,
            code: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Endpoint {
    host: String,
    port: u16,
}

impl Endpoint {
    fn new(host: impl Into<String>, port: u16) -> Result<Self, ()> {
        let host = host.into().trim().to_ascii_lowercase();
        if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") || port == 0 {
            return Err(());
        }
        Ok(Self { host, port })
    }

    fn from_config(value: &Value) -> Result<Self, ()> {
        let server = match value.get("server") {
            None | Some(Value::Null) => None,
            Some(Value::Object(server)) => Some(server),
            Some(_) => return Err(()),
        };
        let host = match server.and_then(|server| server.get("host")) {
            None => "127.0.0.1",
            Some(Value::String(host)) => host.as_str(),
            Some(_) => return Err(()),
        };
        let port = match server.and_then(|server| server.get("port")) {
            None => 8787,
            Some(Value::Number(port)) => port.as_u64().ok_or(())?,
            Some(_) => return Err(()),
        };
        let port = u16::try_from(port).map_err(|_| ())?;
        Self::new(host, port)
    }

    fn with_environment(mut self) -> Result<Self, ()> {
        if let Some(host) = environment_value("GDL_BACKEND_HOST")? {
            self.host = host;
        }
        if let Some(port) = environment_value("GDL_BACKEND_PORT")? {
            self.port = port.parse().map_err(|_| ())?;
        }
        Self::new(self.host, self.port)
    }

    fn authority(&self) -> String {
        if self.host == "::1" {
            format!("[::1]:{}", self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    fn api_origin(&self) -> String {
        format!("http://{}", self.authority())
    }

    fn socket_addresses(&self) -> io::Result<Vec<SocketAddr>> {
        let addresses = (self.host.as_str(), self.port)
            .to_socket_addrs()?
            .filter(|address| address.ip().is_loopback())
            .collect::<Vec<_>>();
        if addresses.is_empty() {
            return Err(io::Error::other("backend host did not resolve to loopback"));
        }
        Ok(addresses)
    }
}

struct LaunchSpec {
    python: PathBuf,
    backend_dir: PathBuf,
    config_path: PathBuf,
    endpoint: Endpoint,
    environment: Vec<(OsString, OsString)>,
}

impl LaunchSpec {
    fn from_app(app: &AppHandle) -> Result<Self, ()> {
        #[cfg(debug_assertions)]
        {
            let _ = app;
            Self::development()
        }
        #[cfg(not(debug_assertions))]
        {
            Self::packaged(app)
        }
    }

    #[cfg(debug_assertions)]
    fn development() -> Result<Self, ()> {
        let backend_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("gallery-dl-backend")
            .canonicalize()
            .map_err(|_| ())?;
        let config_path = environment_value("GDL_BACKEND_CONFIG")?
            .map(PathBuf::from)
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    backend_dir.join(path)
                }
            })
            .unwrap_or_else(|| backend_dir.join("config.json"))
            .canonicalize()
            .map_err(|_| ())?;
        let python = if let Some(python) = environment_value("PYTHON")? {
            PathBuf::from(python)
        } else {
            #[cfg(windows)]
            let candidate = backend_dir.join(".venv/Scripts/python.exe");
            #[cfg(not(windows))]
            let candidate = backend_dir.join(".venv/bin/python");
            if !candidate.is_file() {
                return Err(());
            }
            candidate
        };
        Self::from_paths(python, backend_dir, config_path, Vec::new())
    }

    #[cfg(not(debug_assertions))]
    fn packaged(app: &AppHandle) -> Result<Self, ()> {
        let distribution = BackendDistribution::prepare(
            &app.path().resource_dir().map_err(|_| ())?,
            &app.path().app_config_dir().map_err(|_| ())?,
            &app.path().app_data_dir().map_err(|_| ())?,
        )
        .map_err(|_| ())?;
        let backend_dir = distribution.backend_root.join("app");
        let environment = distribution.environment().into_iter().collect();
        Self::from_paths(
            distribution.python_executable,
            backend_dir,
            distribution.config_path,
            environment,
        )
    }

    fn from_paths(
        python: PathBuf,
        backend_dir: PathBuf,
        config_path: PathBuf,
        environment: Vec<(OsString, OsString)>,
    ) -> Result<Self, ()> {
        if !python.is_file() || !backend_dir.join("gdl_backend/__init__.py").is_file() {
            return Err(());
        }
        let metadata = fs::metadata(&config_path).map_err(|_| ())?;
        if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
            return Err(());
        }
        let config_bytes = fs::read(&config_path).map_err(|_| ())?;
        if config_bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(());
        }
        let config: Value = serde_json::from_slice(&config_bytes).map_err(|_| ())?;
        let endpoint = Endpoint::from_config(&config)?.with_environment()?;
        Ok(Self {
            python,
            backend_dir,
            config_path,
            endpoint,
            environment,
        })
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.python);
        command
            .current_dir(&self.backend_dir)
            .args(["-m", "gdl_backend", "--config"])
            .arg(&self.config_path)
            .env("GDL_BACKEND_PARENT_PIPE", "1")
            .env("IMAGEWEAVE_DESKTOP_DISTRIBUTION", "1")
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        command.envs(self.environment.iter().map(|(key, value)| (key, value)));
        command
    }
}

fn environment_value(name: &str) -> Result<Option<String>, ()> {
    match env::var_os(name) {
        None => Ok(None),
        Some(value) if value.is_empty() => Ok(None),
        Some(value) => value.into_string().map(Some).map_err(|_| ()),
    }
}

struct Inner {
    status: Mutex<BackendStatus>,
    metadata: Mutex<Option<RuntimeMetadata>>,
    process: Mutex<Option<ProcessTree>>,
    shutdown: AtomicBool,
}

#[derive(Clone)]
pub struct BackendManager {
    inner: Arc<Inner>,
}

impl BackendManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                status: Mutex::new(BackendStatus::starting()),
                metadata: Mutex::new(None),
                process: Mutex::new(None),
                shutdown: AtomicBool::new(false),
            }),
        }
    }

    pub fn start(&self, app: AppHandle) {
        let manager = self.clone();
        let thread_app = app.clone();
        if thread::Builder::new()
            .name("imageweave-backend-monitor".into())
            .spawn(move || manager.run(thread_app))
            .is_err()
        {
            self.fail("backend_start_failed");
            reveal_main_window(&app);
        }
    }

    pub fn status(&self) -> BackendStatus {
        *lock(&self.inner.status)
    }

    pub fn metadata(&self) -> Result<RuntimeMetadata, &'static str> {
        lock(&self.inner.metadata)
            .clone()
            .ok_or("backend_not_ready")
    }

    pub fn shutdown(&self) {
        if self.inner.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stop_child(SHUTDOWN_GRACE);
        self.transition(BackendState::Stopped, None);
    }

    fn run(&self, app: AppHandle) {
        if self.inner.shutdown.load(Ordering::SeqCst) {
            return;
        }
        let spec = match LaunchSpec::from_app(&app) {
            Ok(spec) => spec,
            Err(()) => {
                self.fail("backend_config_invalid");
                reveal_main_window(&app);
                return;
            }
        };
        let endpoint = spec.endpoint.clone();
        if self.inner.shutdown.load(Ordering::SeqCst) {
            return;
        }
        let process = match ProcessTree::spawn(&mut spec.command()) {
            Ok(process) => process,
            Err(_) => {
                self.fail("backend_start_failed");
                reveal_main_window(&app);
                return;
            }
        };
        *lock(&self.inner.process) = Some(process);
        if self.inner.shutdown.load(Ordering::SeqCst) {
            self.stop_child(SHUTDOWN_GRACE);
            return;
        }

        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if self.inner.shutdown.load(Ordering::SeqCst) {
                return;
            }
            if self.child_exited() {
                if self.inner.shutdown.load(Ordering::SeqCst) {
                    return;
                }
                self.fail("backend_exited");
                reveal_main_window(&app);
                return;
            }
            if let Some(metadata) = probe_backend(&endpoint) {
                *lock(&self.inner.metadata) = Some(metadata);
                self.transition(BackendState::Ready, None);
                reveal_main_window(&app);
                break;
            }
            if Instant::now() >= deadline {
                self.stop_child(SHUTDOWN_GRACE);
                self.fail("backend_start_timeout");
                reveal_main_window(&app);
                return;
            }
            thread::sleep(PROBE_INTERVAL);
        }

        while !self.inner.shutdown.load(Ordering::SeqCst) {
            if self.child_exited() {
                if !self.inner.shutdown.load(Ordering::SeqCst) {
                    self.fail("backend_exited");
                    reveal_main_window(&app);
                }
                return;
            }
            thread::sleep(MONITOR_INTERVAL);
        }
    }

    fn child_exited(&self) -> bool {
        let mut process = lock(&self.inner.process);
        let exited = match process.as_mut() {
            Some(process) => !matches!(process.try_wait(), Ok(None)),
            None => true,
        };
        if exited {
            process.take();
        }
        exited
    }

    fn stop_child(&self, grace: Duration) {
        if let Some(mut process) = lock(&self.inner.process).take() {
            let _ = process.graceful_shutdown(grace);
        }
    }

    fn fail(&self, code: &'static str) {
        *lock(&self.inner.metadata) = None;
        self.transition(BackendState::Failed, Some(code));
    }

    fn transition(&self, state: BackendState, code: Option<&'static str>) {
        *lock(&self.inner.status) = BackendStatus { state, code };
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn reveal_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn probe_backend(endpoint: &Endpoint) -> Option<RuntimeMetadata> {
    let (health_status, health) = request_json(endpoint, HEALTH_PATH).ok()?;
    if health_status != 200 || health.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let (version_status, root) = request_json(endpoint, VERSION_PATH).ok()?;
    if version_status != 200 {
        return None;
    }
    let version = root.get("version")?.as_str()?;
    if !valid_version(version) {
        return None;
    }
    Some(RuntimeMetadata {
        api_origin: endpoint.api_origin(),
        backend_version: version.to_owned(),
    })
}

fn valid_version(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 64
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '+' | '_' | '-')
        })
}

fn request_json(endpoint: &Endpoint, path: &str) -> io::Result<(u16, Value)> {
    let mut last_error = None;
    let mut stream = None;
    for address in endpoint.socket_addresses()? {
        match TcpStream::connect_timeout(&address, IO_TIMEOUT) {
            Ok(connection) => {
                stream = Some(connection);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let mut stream = stream.ok_or_else(|| {
        last_error.unwrap_or_else(|| io::Error::other("backend loopback connection failed"))
    })?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        endpoint.authority()
    )?;
    stream.flush()?;

    let mut response = Vec::new();
    stream.take(MAX_HTTP_BYTES + 1).read_to_end(&mut response)?;
    if response.len() as u64 > MAX_HTTP_BYTES {
        return Err(io::Error::other("backend response exceeded limit"));
    }
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| io::Error::other("backend response headers are invalid"))?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| io::Error::other("backend response headers are not UTF-8"))?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| io::Error::other("backend response status is invalid"))?;
    let payload = serde_json::from_slice(&response[header_end + 4..])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok((status, payload))
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        path::Path,
        sync::mpsc,
    };

    use super::*;

    #[test]
    fn endpoint_accepts_only_configured_loopback_hosts_and_ports() {
        for host in ["127.0.0.1", "localhost", "::1", " LOCALHOST "] {
            assert!(Endpoint::new(host, 8787).is_ok(), "{host}");
        }
        for host in ["0.0.0.0", "192.168.1.2", "evil.example.com", ""] {
            assert!(Endpoint::new(host, 8787).is_err(), "{host}");
        }
        assert!(Endpoint::new("127.0.0.1", 0).is_err());
    }

    #[test]
    fn endpoint_reads_only_server_host_and_port_from_existing_config() {
        let config = serde_json::json!({
            "server": {"host": "127.0.0.1", "port": 9123, "cors_origins": ["tauri://localhost"]},
            "auth": {"token": "never expose"}
        });
        let endpoint = Endpoint::from_config(&config).expect("valid endpoint");
        assert_eq!(endpoint.api_origin(), "http://127.0.0.1:9123");
        assert!(Endpoint::from_config(&serde_json::json!({"server": {"port": 70000}})).is_err());
        assert!(Endpoint::from_config(&serde_json::json!({"server": []})).is_err());
    }

    #[test]
    fn launch_command_uses_existing_python_module_config_and_parent_pipe() {
        let spec = LaunchSpec {
            python: PathBuf::from("python"),
            backend_dir: PathBuf::from("backend"),
            config_path: PathBuf::from("backend/config.json"),
            endpoint: Endpoint::new("127.0.0.1", 8787).expect("endpoint"),
            environment: vec![(
                OsString::from("IMAGEWEAVE_DESKTOP_PYTHON"),
                OsString::from("backend/runtime/python/bin/python3"),
            )],
        };
        let command = spec.command();
        let arguments = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            arguments,
            ["-m", "gdl_backend", "--config", "backend/config.json"]
        );
        assert_eq!(command.get_current_dir(), Some(Path::new("backend")));
        assert!(command.get_envs().any(|(name, value)| {
            name == "GDL_BACKEND_PARENT_PIPE" && value == Some(std::ffi::OsStr::new("1"))
        }));
        assert!(command.get_envs().any(|(name, value)| {
            name == "IMAGEWEAVE_DESKTOP_DISTRIBUTION" && value == Some(std::ffi::OsStr::new("1"))
        }));
        assert!(command.get_envs().any(|(name, value)| {
            name == "IMAGEWEAVE_DESKTOP_PYTHON"
                && value == Some(std::ffi::OsStr::new("backend/runtime/python/bin/python3"))
        }));
    }

    #[test]
    fn healthz_is_the_only_startup_gate_and_version_is_public_metadata() {
        let responses = [
            (
                HEALTH_PATH,
                r#"{"ok":true,"components":{"database":{"status":"ok"}}}"#,
            ),
            (
                VERSION_PATH,
                r#"{"service":"gallery-dl-backend","version":"0.5.2"}"#,
            ),
        ];
        let (endpoint, requests, server) = fake_http_server(&responses);

        let metadata = probe_backend(&endpoint).expect("healthy backend");

        assert_eq!(metadata.api_origin, endpoint.api_origin());
        assert_eq!(metadata.backend_version, "0.5.2");
        assert_eq!(
            requests.recv().expect("health request"),
            "GET /healthz HTTP/1.1"
        );
        assert_eq!(requests.recv().expect("version request"), "GET / HTTP/1.1");
        server.join().expect("fake server");
    }

    #[test]
    fn unhealthy_healthz_never_advances_to_ready_or_queries_readyz() {
        let responses = [(HEALTH_PATH, r#"{"ok":false}"#)];
        let (endpoint, requests, server) = fake_http_server(&responses);

        assert!(probe_backend(&endpoint).is_none());
        assert_eq!(
            requests.recv().expect("health request"),
            "GET /healthz HTTP/1.1"
        );
        assert!(requests.try_recv().is_err());
        server.join().expect("fake server");
    }

    #[test]
    fn runtime_payloads_have_exact_non_sensitive_shapes() {
        let metadata = RuntimeMetadata {
            api_origin: "http://127.0.0.1:8787".into(),
            backend_version: "0.5.2".into(),
        };
        let metadata = serde_json::to_value(metadata).expect("serialize metadata");
        assert_eq!(
            metadata
                .as_object()
                .expect("metadata object")
                .keys()
                .collect::<Vec<_>>(),
            ["apiOrigin", "backendVersion"]
        );

        let status = serde_json::to_value(BackendStatus {
            state: BackendState::Failed,
            code: Some("backend_exited"),
        })
        .expect("serialize status");
        assert_eq!(
            status
                .as_object()
                .expect("status object")
                .keys()
                .collect::<Vec<_>>(),
            ["code", "state"]
        );
    }

    #[test]
    fn lifecycle_errors_and_shutdown_are_controlled_public_states() {
        let manager = BackendManager::new();
        let starting = manager.status();
        assert_eq!(
            (starting.state, starting.code),
            (BackendState::Starting, None)
        );
        manager.fail("backend_config_invalid");
        let invalid = manager.status();
        assert_eq!(
            (invalid.state, invalid.code),
            (BackendState::Failed, Some("backend_config_invalid"))
        );
        assert!(manager.metadata().is_err());
        manager.fail("backend_exited");
        assert_eq!(manager.status().code, Some("backend_exited"));
        for _ in 0..2 {
            manager.shutdown();
        }
        let stopped = manager.status();
        assert_eq!((stopped.state, stopped.code), (BackendState::Stopped, None));
    }
    fn fake_http_server(
        responses: &[(&'static str, &'static str)],
    ) -> (Endpoint, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake backend");
        let port = listener.local_addr().expect("fake backend address").port();
        let responses = responses.to_vec();
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            for (expected_path, body) in responses {
                let (mut stream, _) = listener.accept().expect("accept probe");
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .expect("set fake timeout");
                let mut request = Vec::new();
                let mut chunk = [0_u8; 512];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let count = stream.read(&mut chunk).expect("read probe");
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..count]);
                }
                let request_line = String::from_utf8_lossy(&request)
                    .lines()
                    .next()
                    .expect("probe request line")
                    .to_owned();
                assert_eq!(request_line, format!("GET {expected_path} HTTP/1.1"));
                sender.send(request_line).expect("record probe");
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .expect("write fake response");
            }
        });
        (
            Endpoint::new("127.0.0.1", port).expect("fake endpoint"),
            receiver,
            server,
        )
    }
}
