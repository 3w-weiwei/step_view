# VLM + MCP 评测脚本

这个目录下的 Python 文件用于比较两种分析方式：

- 基线 VLM 分析
- 接入 MCP 后的增强 VLM 分析

目标是评估 MCP 是否能帮助 VLM 更好地完成以下任务：

- 装配关系识别
- 子装配判断
- 基座选择
- 夹持方案推理
- 装配顺序推理

## 文件说明

- `mcp_http_client.py`
  - 纯标准库实现的最小 MCP Streamable HTTP 客户端
- `openai_vision_client.py`
  - OpenAI 兼容 `/chat/completions` 的视觉模型客户端
- `run_mcp_vlm_eval.py`
  - 主评测脚本
- `eval_cases.sample.json`
  - 样例评测用例
- `output/`
  - 评测输出目录

## 当前脚本流程

### 基线流程

基线 VLM 只看：

- `globalBeautyViews`

用于模拟“只有普通图片，没有 MCP 结构化辅助”的情况。

### MCP 增强流程

当前是两轮：

1. 第 1 轮
   - VLM 读取 `model_context` 和 `relation_candidates`
   - 先做中文初判
   - 选择下一轮最值得查看的 `candidate_id`
2. 第 2 轮
   - MCP 抓取 `evidence_bundle`
   - VLM 读取：
     - beauty 图
     - part mask 调色板图
     - local overlay 图
     - local face mask 调色板图
     - 结构化 MCP 上下文
   - 输出最终分析结果
3. 附加验证
   - 对 MCP 增强结果中的首个 relation hypothesis 进行 `assembly.validate_hypothesis`

## 交互记录

每个 case 的输出目录中都会生成：

- `interaction_trace.json`

这个文件会按时间顺序记录：

- 每一次 MCP 调用
- 每一次 MCP 返回
- 每一次资源读取
- 每一次 VLM 调用
- 每一次 VLM 返回`r`n- 每轮 VLM 的 token 消耗

因此它就是你要的“VLM 与 MCP 多轮交互记录”。

## 运行前准备

1. 激活 conda 环境
2. 启动 Electron 应用，并确认以下地址可访问：

```bash
http://127.0.0.1:3765/health
```

3. 如果需要实际调用 VLM，请确保环境变量已配置，例如：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

## 运行示例

只收集 MCP 产物，不调用 VLM：

```bash
python tests/run_mcp_vlm_eval.py --cases tests/eval_cases.sample.json --skip-vlm
```

运行完整中文双轮评测：

```bash
python tests/run_mcp_vlm_eval.py --cases tests/eval_cases.sample.json
```

指定 MCP 地址：

```bash
python tests/run_mcp_vlm_eval.py --mcp-url http://127.0.0.1:3765/mcp
```

## 输出文件

每个 case 会在 `tests/output/` 下生成一个时间戳目录，常见文件包括：

- `model_context.json`
- `relation_candidates.json`
- `evidence_bundle.json`
- 抓取下来的图片文件
- `mcp_round1_plan.json`
- `baseline_vlm.json`
- `mcp_augmented_vlm.json`
- `validation.json`
- `score_summary.json`，前提是 case 里填了 expected
- `interaction_trace.json`

## expected 标注

样例 case 里的 expected 目前基本留空。

后续你可以逐步填写：

- `base_part_id`
- `relation_pairs`
- `subassemblies`
- `sequence_part_order`

填完后，脚本会自动输出一个简单的 baseline vs MCP score summary。

