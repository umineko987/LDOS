# AGENTS.md

## 开发环境

- 测试与运行用仓库根目录 `.venv`（dedup venv，含 onnxruntime/numpy/Pillow/torch）；系统 `python3` 无 numpy。
- 跑测试：`.venv/bin/python -m unittest discover -s tests -p "test_<模块>_*"`；测试为 unittest 风格，通过 `sys.path.insert(0, ROOT / "<模块目录>")` 平铺导入。
- 用户要求原子化提交：每个提交独立可验证（代码 + 对应测试一起）。

## tagger 模块（booru 打标）

设计契约（改动前先读）：

- 统一四动作接口：`load() / infer_scores(images) -> [B, N] / close()`，外加安装期 `install()`。分数**未做任何阈值筛选**、与词表顺序严格一致；`{category: {tag: score}}` 只在外层生成。
- 两级缓存身份（`tagger/cache.py`）：推理层 = 模型指纹 × 文件内容 SHA256（fp32 BLOB）；筛选层再叠加策略指纹。**改阈值绝不重推理**；适配器/预处理/词表变化必须体现在模型指纹里（`adapters.ADAPTER_VERSION` 递增）。
- 新模型接入点：`tagger/specs.py` 登记一条（固定 revision + 文件清单 + SHA256 + 适配器名），必要时在 `adapters.py` 加适配器。
- 打标预处理用 `tagger/preprocess.load_image`（EXIF 转正 + 透明垫白）；**不能**复用 `dedup/dedup_models.py` 的 `_open_rgb`（那是透明垫黑）。
- caption 导出：首模型写图片同名 `.txt`，其余模型写 `stem.{key}.txt`；下划线转空格只作用于纯小写标签（保护 kaomoji）。

## 已知坑（已验证）

- 模型下载**不做哈希校验**（用户明确决定：纯过度防御）；下载地址固定为 `repo@revision` 直链，防的是"上游变动"而不是"字节损坏"。
- WD 系列 ONNX：激活已烘焙进图，输出即概率，不要再 sigmoid；输入 NHWC/BGR/0-255 原始值。
- gated 模型（如 cella110n/cl_tagger_v2）的 token 在 `/home/umineko/Projects/LDOS/hf_at.txt`，只在下载期使用、不落日志。

## 未实现（规划中的后续）

- canary（timm+safetensors）、pixai（transformers remote code，需 pin 全文件集 + `local_files_only` 加载）、CL（SigLIP2/384/输出是 logits 需自行 sigmoid，六类含 Quality，自定义许可需应用内同意流程）。
- 接口冻结前先用各真模型做一次小规模加载验证（评审结论，避免造出只有 WD 能用的接口）。
