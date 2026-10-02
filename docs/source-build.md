# 从源码构建 LDOS

[English](source-build.en.md)

当前支持 Linux x86_64 和 Windows x86_64 原生构建。

## 准备环境

- Git
- Python 3.13，且 `python` 命令可用
- Node.js 24.13.0 与 npm
- Rust 1.98.0 与 `rustfmt`
- 对应平台的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)
- Windows 还需要 MSVC C++ 构建工具和已加入 `PATH` 的 7-Zip

## 获取源码

```bash
git clone --recurse-submodules https://github.com/KKKneko/LDOS.git
cd LDOS
```

## Linux 构建

```bash
python scripts/desktop_release.py build
```

## Windows 构建

在 PowerShell 中执行：

```powershell
python .\scripts\desktop_release.py build
```

## 构建产物

- Linux：`desktop/src-tauri/target/release/bundle/deb/` 和 `appimage/`
- Windows：`desktop/src-tauri/target/release/bundle/nsis/`

## 启动

Linux 直接运行构建出的 AppImage：

```bash
chmod +x desktop/src-tauri/target/release/bundle/appimage/*.AppImage
./desktop/src-tauri/target/release/bundle/appimage/*.AppImage
```

Windows 双击 `desktop\src-tauri\target\release\bundle\nsis\` 中的安装程序，安装后从开始菜单启动 **LDOS**。后端会随桌面应用自动启动。
