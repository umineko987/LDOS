# Build LDOS from Source

[简体中文](source-build.md)

Native builds currently support Linux x86_64 and Windows x86_64.

## Prerequisites

- Git
- Python 3.13 with the `python` command available
- Node.js 24.13.0 with npm
- Rust 1.98.0 with `rustfmt`
- The [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your platform
- On Windows, the MSVC C++ build tools and 7-Zip available through `PATH`

## Get the Source

```bash
git clone --recurse-submodules https://github.com/KKKneko/LDOS.git
cd LDOS
```

## Build on Linux

```bash
python scripts/desktop_release.py build
```

## Build on Windows

Run in PowerShell:

```powershell
python .\scripts\desktop_release.py build
```

## Build Outputs

- Linux: `desktop/src-tauri/target/release/bundle/deb/` and `appimage/`
- Windows: `desktop/src-tauri/target/release/bundle/nsis/`

## Launch

Run the generated AppImage on Linux:

```bash
chmod +x desktop/src-tauri/target/release/bundle/appimage/*.AppImage
./desktop/src-tauri/target/release/bundle/appimage/*.AppImage
```

On Windows, run the installer in `desktop\src-tauri\target\release\bundle\nsis\`, then launch **LDOS** from the Start menu. The backend starts automatically with the desktop application.
