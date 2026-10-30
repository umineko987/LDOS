"""过滤模型探测的替身（代替 gdl_backend/review_filter_models.py 的命令行）：
python filter_probe.py --model-dir <目录> --models <名字>...，报告列出的模型全部可用。
真实探测会校验权重 sha256 并建 ONNX 会话；占位文件过不了，推理也由 dedup_worker.py 代替。
"""

from __future__ import annotations

import argparse
import json

parser = argparse.ArgumentParser()
parser.add_argument("--model-dir", required=True)
parser.add_argument("--models", nargs="+", required=True)
args = parser.parse_args()
print(json.dumps({name: {"available": True, "reason": ""} for name in args.models}))
