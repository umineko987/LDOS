# ImageWeave 图库（含导出）开发 CHANGELOG

本文件记录按 `docs/图库(含导出).md`（本地文档，不入库）实施的图库与数据集导出开发进度：每个原子提交的改动、决策与阻塞。阶段划分为 G0–G6；每阶段独立提交并只提交本阶段所属文件。

条目格式：`[Gx] 类型: 标题`，附改动文件、验证命令与状态（✅ 通过 / 🔴 预期红 / ⛔ 阻塞）。

---

## G0 · 合同、schema 设计与 red-first 测试

### [G0-1] feat(db): schema v9 图库与数据集导表现

- 状态：✅ 后端全量测试通过（569 tests OK）
- `gallery-dl-backend/gdl_backend/_database_schema.py`
  - `CURRENT_SCHEMA_VERSION` 8 → 9；新增 `GALLERY_EXPORT_SCHEMA_VERSION = 9`。
  - 新增表（全部幂等 `CREATE ... IF NOT EXISTS`，fresh 与 v8 升级路径共用）：`gallery_sources`、`gallery_directories`、`gallery_assets`、`gallery_file_operations`、`gallery_file_operation_items`、`dataset_export_jobs`、`dataset_export_sources`、`dataset_export_items`、`dataset_export_events`。
  - 新增 FTS5 虚拟表 `gallery_search_index`（asset_id/source_id UNINDEXED + file_name/relative_path/txt_content）。运行时缺失 FTS5 时抛出明确 RuntimeError（计划 §5.4：不允许静默降级为浏览器全量搜索）。
  - v8 站点策略迁移块改为显式写入版本 `"8"`（原先写 `CURRENT_SCHEMA_VERSION`，版本常量前进后语义错误）；新增 v9 版本标记迁移块。
- `gallery-dl-backend/tests/test_gallery_export_schema.py`（新增）
  - fresh 建库、v8→v9 升级（保留爬取数据）、重复启动幂等、版本标记事务失败回滚后可恢复、FTS5 可用性探测。
  - 断言表级列契约子集，防止后续 repository 退化成无边界 JSON 大表。
- `gallery-dl-backend/tests/test_database.py`
  - 两个 schema 版本断言 `"8"` → `"9"`（合法版本合同前进）。
- `.gitignore`：新增 `!/docs/CHANGELOG.md` 白名单；`docs/图库(含导出).md` 保持本地不入库。

### 阶段备注

- 阻塞：无。
- 待办（本阶段内）：G0-2 纯函数合同（TXT 状态/自然排序/路径安全/manifest）、G0-3 后端 API 路由 red-first 契约、G0-4 桌面端 Gallery/Export 目标合同测试（red）。
