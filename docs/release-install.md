# 从 Release 安装 LDOS

[English](release-install.en.md)

当前提供 Linux x86_64 和 Windows x86_64 安装包，无需准备 Python、Node.js 或 Rust 环境。

前往 [LDOS Releases](https://github.com/KKKneko/LDOS/releases/latest) 下载对应平台的安装包。

## Linux

Debian / Ubuntu 下载 `.deb`：

```bash
sudo apt install ./LDOS_*_amd64.deb
```

其他支持 AppImage 的发行版下载 `.AppImage`：

```bash
chmod +x LDOS_*_amd64.AppImage
./LDOS_*_amd64.AppImage
```

## Windows

下载 `LDOS_*_x64-setup.exe`，双击并按安装向导完成安装，然后从开始菜单启动 **LDOS**。
