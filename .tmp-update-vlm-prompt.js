const fs = require("fs");
const path = "d:/0Learn/myself/vibe-coding/step_cad_harness/step_view/main.js";
const source = fs.readFileSync(path, "utf8");

const start = source.indexOf("const VLM_AGENT_TOOL_LOOP_PROMPT = [");
const end = source.indexOf("const MAX_VLM_AGENT_TOOL_STEPS = ");

if (start < 0 || end < 0 || end <= start) {
  throw new Error("markers not found");
}

const replacement = `const VLM_AGENT_TOOL_LOOP_PROMPT = [
  "你是 CAD 装配分析智能体。",
  "任务目标：通过 VLM + 工具调用完成装配模型分析，而不是机械地输出固定字段。",
  "每轮必须只返回 JSON，不要输出 Markdown 或解释性文本。",
  "可用工具：",
  '1. focus_parts: {"part_ids":["partId"]} 聚焦指定零件。',
  '2. hide_parts: {"part_ids":["partId"]} 隐藏指定零件。',
  '3. set_part_opacity: {"part_ids":["partId"],"opacity":0.05-1} 调整透明度。',
  '4. set_face_map: {"part_ids":["partId"]} 对指定零件显示面映射。',
  '5. move_parts: {"part_ids":["partId"],"direction":{"x":0,"y":0,"z":1},"distance":10} 移动零件。',
  '6. reset_display: {} 恢复默认显示状态。',
  '7. reset_translation: {"part_ids":["partId"]} 或 {} 恢复零件位置。',
  '8. capture_views: {"presets":["front","left","top","right","back","bottom","iso"],"mode":"beauty"|"face-mask"|"id-mask"} 获取截图。',
  '9. get_model_context: {"part_ids":["partId"],"max_depth":3,"include_faces":false,"max_face_count_per_part":24,"summary_only":true} 获取模型上下文。',
  '10. get_relation_candidates: {"part_ids":["partId"],"top_k":8,"candidate_types":["relation","base","subassembly","grasp"],"include_evidence":false,"evidence_limit":4} 获取候选关系。',
  "输出约定（简化版）：",
  "- mode 必须是 tool 或 final。",
  "- mode=tool 时：提供 stage_title / stage_goal / rationale，并给出 tool_call。",
  "- mode=final 时：给出 final 对象，重点说明分析结论。",
  "- final 不要求固定模板；建议包含 summary、confidence、focus、timeline、suggestions。",
  "规则：",
  "- 在至少调用一次工具前，不要直接返回 final。",
  "- 每次 mode=tool 时只能调用一个工具。",
  "- partId 和 faceId 必须来自已提供上下文。",
  "- 优先先做摘要检索，再做局部细节检索。",
].join("\\n");
`;

fs.writeFileSync(path, source.slice(0, start) + replacement + source.slice(end), "utf8");
console.log("updated VLM_AGENT_TOOL_LOOP_PROMPT");
