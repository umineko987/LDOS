# LDOS

**LoRA Dataset Operating System**

[English](README_EN.md)

LDOS 是围绕 [gallery-dl](https://codeberg.org/mikf/gallery-dl) 构建的本地 LoRA 数据集工作台，用于完成图片采集、批次调度、图库整理与去重审核。

## 特性介绍

- **有序图片采集**：搜索来源、选择地址，并按输入顺序创建和执行采集批次。
- **批次与任务管理**：查看任务进度，取消、重试或重新规划采集批次。
- **代理与站点授权**：管理代理来源、连接探测、站点授权和托管浏览器会话。
- **去重审核**：结合感知哈希与 SSCD、DINO 深度模型生成重复候选，支持人工确认并应用整理结果。
- **图片库与数据集导出**：浏览、检索和管理已下载图片，将完整目录复制到数据集目标。
- **本地桌面工作区**：Tauri + Svelte 桌面界面连接本地 FastAPI 服务；后端默认仅监听回环地址，任务与图库状态保存在本地 SQLite 和文件系统中。

## 快速开始

README 仅保留入口；请选择适合你的安装方式查看完整步骤：

| 方式 | 适用场景 | 文档 |
|---|---|---|
| 源码构建 | 在 Linux 或 Windows 主机上复现桌面发布构建 | [从源码构建 LDOS](docs/source-build.md) |
| Release 安装 | 直接安装 Linux 或 Windows x86_64 官方发布包 | [从 Release 安装 LDOS](docs/release-install.md) |
