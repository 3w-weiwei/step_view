const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { startMcpHttpServer } = require("./mcp/http-server");
const {
  setWindowProvider,
  updateRendererState,
  getRendererState,
  requestRendererCapture,
  requestRendererCommand,
  handleCaptureResponse,
  handleCommandResponse,
} = require("./mcp/bridge");
const {
  buildReasoningSummary,
  buildReasoningConstraints,
  buildReasoningTransform,
  buildReasoningPlan,
  buildReasoningStep,
} = require("./mcp/reasoning-service");
const {
  buildModelContext,
  buildAnalysisCandidates,
  buildEvidenceTarget,
} = require("./mcp/analysis-v3");

const {
  configureProjectRoot,
  ensureProjectStore,
  listProjects,
  importProjectFromFile,
  getProjectDetails,
  retryProject,
  renameProject,
  deleteProject,
  getProjectManifest,
  getProjectDirectory,
  onProjectUpdate,
} = require("./project-service");

let mainWindow = null;
let mcpServerHandle = null;
let currentMcpServerStatus = {
  ok: false,
  host: "127.0.0.1",
  preferredPort: 3765,
  port: null,
  usedFallbackPort: false,
  error: "",
};
const DEFAULT_VLM_TIMEOUT_MS = 240000;
const DEFAULT_VLM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_VLM_MODEL = "qwen3-vl-plus";
const VLM_SYSTEM_PROMPT = [
  "你是 CAD 装配分析智能体，需要结合结构化上下文与图像证据输出可执行结论。",
  "必须仅输出 JSON，不要输出 Markdown 或额外说明。",
  "输出结构：",
  "{",
  '  "summary": "字符串，简短总结",',
  '  "confidence": 0 到 1 之间数字,',
  '  "focus": {',
  '    "basePartId": "字符串或null",',
  '    "assemblingPartId": "字符串或null",',
  '    "focusPartIds": ["字符串"],',
  '    "baseFaceIds": ["字符串"],',
  '    "assemblingFaceIds": ["字符串"],',
  '    "insertionAxis": { "origin": {"x":0,"y":0,"z":0}, "direction": {"x":0,"y":0,"z":1}, "length": 数字 } 或 null',
  "  },",
  '  "timeline": [',
  "    {",
  '      "title": "阶段名称",',
  '      "detail": "阶段解释",',
  '      "basePartId": "字符串或null",',
  '      "assemblingPartId": "字符串或null",',
  '      "focusPartIds": ["字符串"],',
  '      "baseFaceIds": ["字符串"],',
  '      "assemblingFaceIds": ["字符串"],',
  '      "focusFaceIds": ["字符串"],',
  '      "insertionAxis": 同 focus.insertionAxis',
  "    }",
  "  ],",
  '  "suggestions": ["下一步建议"]',
  "}",
  "约束：partId/faceId 必须来自输入上下文，不可杜撰。",
].join("\n");
const VLM_AGENT_TOOL_LOOP_PROMPT = [
  "你是一个 CAD 装配分析智能体。",
  "你必须根据用户指令完成任务，并优先使用显示控制工具逐步观察装配体，然后再输出最终分析。",
  "每一轮严格只返回 JSON，不要输出 Markdown 或解释性文本。",
  "可用工具：",
  '1. focus_parts: {"part_ids":["partId"]} 只聚焦指定零件。',
  '2. hide_parts: {"part_ids":["partId"]} 隐藏指定零件。',
  '3. set_part_opacity: {"part_ids":["partId"],"opacity":0.05-1} 设置指定零件不透明度。',
  '4. set_face_map: {"part_ids":["partId"]} 仅对指定零件显示高饱和面映射。',
  '5. move_parts: {"part_ids":["partId"],"direction":{"x":0,"y":0,"z":1},"distance":10} 沿方向移动零件。',
  '6. reset_display: {} 恢复默认显示范围和普通显示模式。',
  '7. reset_translation: {"part_ids":["partId"]} 或 {} 恢复零件默认位置。',
  '8. capture_views: {"presets":["front","left","top","right","back","bottom","iso"],"mode":"beauty"|"face-mask"|"id-mask"} 获取指定视角截图。',
  "返回 JSON 结构：",
  "{",
  '  "mode": "tool" | "final",',
  '  "stage_title": "阶段标题",',
  '  "stage_goal": "本阶段目标",',
  '  "rationale": "为什么这样做",',
  '  "tool_call": { "name": "工具名", "arguments": { ... } },',
  '  "final": {',
  '    "summary": "字符串",',
  '    "confidence": 0.0,',
  '    "focus": {',
  '      "basePartId": "字符串或null",',
  '      "assemblingPartId": "字符串或null",',
  '      "focusPartIds": ["字符串"],',
  '      "baseFaceIds": ["字符串"],',
  '      "assemblingFaceIds": ["字符串"],',
  '      "insertionAxis": { "origin": {"x":0,"y":0,"z":0}, "direction": {"x":0,"y":0,"z":1}, "length": 数字 } 或 null',
  "    },",
  '    "timeline": [',
  "      {",
  '        "title": "阶段名称",',
  '        "detail": "阶段解释",',
  '        "basePartId": "字符串或null",',
  '        "assemblingPartId": "字符串或null",',
  '        "focusPartIds": ["字符串"],',
  '        "baseFaceIds": ["字符串"],',
  '        "assemblingFaceIds": ["字符串"],',
  '        "focusFaceIds": ["字符串"],',
  '        "insertionAxis": 同 focus.insertionAxis',
  "      }",
  "    ],",
  '    "suggestions": ["下一步建议"]',
  "  }",
  "}",
  "规则：",
  "- 在至少调用一次工具前，不要直接返回 final。",
  "- 每次 mode=tool 时只能调用一个工具。",
  "- partId 和 faceId 必须来自已提供上下文。",
].join("\n");
const MAX_VLM_AGENT_TOOL_STEPS = 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/g, "");
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function resolveVlmConfig(payload = {}) {
  const apiKey = payload.apiKey || process.env.VLM_API_KEY || process.env.OPENAI_API_KEY || "sk-3af0625d1a754b429a3855372f21db16";
  const baseUrl = trimTrailingSlash(
    payload.baseUrl ||
      process.env.VLM_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      DEFAULT_VLM_BASE_URL,
  );
  const model = payload.model || process.env.VLM_MODEL || process.env.OPENAI_MODEL || DEFAULT_VLM_MODEL;
  const timeoutMs = Math.max(
    15000,
    Number(payload.timeoutMs || process.env.VLM_TIMEOUT_MS || DEFAULT_VLM_TIMEOUT_MS),
  );

  if (!apiKey) {
    throw new Error("缺少 VLM API Key，请设置 VLM_API_KEY 或 OPENAI_API_KEY。");
  }

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
  };
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => item && typeof item === "object" && item.type === "text")
      .map((item) => String(item.text || ""))
      .join("\n")
      .trim();
  }

  return "";
}

function stripCodeFence(text = "") {
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  }
  return trimmed;
}

function tryParseJsonText(rawText) {
  const attempts = [];
  const direct = stripCodeFence(rawText || "");
  if (direct) {
    attempts.push(direct);
  }

  const firstBrace = direct.indexOf("{");
  const lastBrace = direct.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(direct.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // continue
    }
  }

  return null;
}

function normalizeVector(vector, fallback = { x: 0, y: 0, z: 1 }) {
  const x = toFiniteNumber(vector?.x, fallback.x);
  const y = toFiniteNumber(vector?.y, fallback.y);
  const z = toFiniteNumber(vector?.z, fallback.z);
  const length = Math.sqrt(x ** 2 + y ** 2 + z ** 2);
  if (!length) {
    return { ...fallback };
  }
  return {
    x: x / length,
    y: y / length,
    z: z / length,
  };
}

function normalizeInsertionAxis(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const origin = value.origin && typeof value.origin === "object"
    ? {
        x: toFiniteNumber(value.origin.x, 0),
        y: toFiniteNumber(value.origin.y, 0),
        z: toFiniteNumber(value.origin.z, 0),
      }
    : null;
  const direction = normalizeVector(value.direction || { x: 0, y: 0, z: 1 });
  const length = toFiniteNumber(value.length, 16);

  return {
    origin,
    direction,
    length: Math.max(8, length),
  };
}

function normalizeFocusPayload(rawFocus = {}) {
  const focusPartIds = unique([
    ...(Array.isArray(rawFocus.focusPartIds) ? rawFocus.focusPartIds : []),
    rawFocus.basePartId,
    rawFocus.assemblingPartId,
  ]);
  return {
    basePartId: rawFocus.basePartId || focusPartIds[0] || null,
    assemblingPartId: rawFocus.assemblingPartId || focusPartIds[1] || null,
    focusPartIds,
    baseFaceIds: unique(Array.isArray(rawFocus.baseFaceIds) ? rawFocus.baseFaceIds : []),
    assemblingFaceIds: unique(Array.isArray(rawFocus.assemblingFaceIds) ? rawFocus.assemblingFaceIds : []),
    insertionAxis: normalizeInsertionAxis(rawFocus.insertionAxis),
  };
}

function normalizeTimelineEntry(entry, index = 0) {
  const raw = entry && typeof entry === "object" ? entry : {};
  const focusPartIds = unique([
    ...(Array.isArray(raw.focusPartIds) ? raw.focusPartIds : []),
    raw.basePartId,
    raw.assemblingPartId,
  ]);
  return {
    stageId: raw.stageId || `stage_${index + 1}`,
    title: String(raw.title || raw.stage || `阶段 ${index + 1}`),
    detail: String(raw.detail || raw.description || ""),
    basePartId: raw.basePartId || focusPartIds[0] || null,
    assemblingPartId: raw.assemblingPartId || focusPartIds[1] || null,
    focusPartIds,
    focusFaceIds: unique(Array.isArray(raw.focusFaceIds) ? raw.focusFaceIds : []),
    baseFaceIds: unique(Array.isArray(raw.baseFaceIds) ? raw.baseFaceIds : []),
    assemblingFaceIds: unique(Array.isArray(raw.assemblingFaceIds) ? raw.assemblingFaceIds : []),
    insertionAxis: normalizeInsertionAxis(raw.insertionAxis),
  };
}

function normalizeVlmOutput(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const summary = String(
    payload.summary || payload.analysis || payload.finalSummary || "VLM 已完成本轮装配分析。",
  ).trim();
  const confidence = clamp(toFiniteNumber(payload.confidence, 0.5), 0, 1);
  const focus = normalizeFocusPayload(payload.focus || payload.focusTarget || payload);
  const rawTimeline = Array.isArray(payload.timeline)
    ? payload.timeline
    : Array.isArray(payload.agentThoughtProcess)
      ? payload.agentThoughtProcess
      : [];
  const timeline = rawTimeline.map((item, index) => normalizeTimelineEntry(item, index)).slice(0, 16);

  if (!timeline.length) {
    timeline.push({
      stageId: "stage_1",
      title: "结果汇总",
      detail: summary,
      basePartId: focus.basePartId,
      assemblingPartId: focus.assemblingPartId,
      focusPartIds: focus.focusPartIds,
      focusFaceIds: unique([...focus.baseFaceIds, ...focus.assemblingFaceIds]),
      baseFaceIds: focus.baseFaceIds,
      assemblingFaceIds: focus.assemblingFaceIds,
      insertionAxis: focus.insertionAxis,
    });
  }

  const suggestions = Array.isArray(payload.suggestions)
    ? payload.suggestions.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
    : [];

  return {
    summary,
    confidence,
    focus,
    timeline,
    suggestions,
  };
}

function summarizeModelContextForVlm(modelContext) {
  return {
    projectId: modelContext.projectId,
    projectName: modelContext.projectName,
    parserMode: modelContext.parserMode,
    geometryMode: modelContext.geometryMode,
    assembly: modelContext.assembly,
    parts: (modelContext.parts || []).slice(0, 24).map((part) => ({
      partId: part.partId,
      name: part.name,
      tags: part.tags,
      faceCount: part.faceCount,
      bbox: part.bbox,
    })),
  };
}

function summarizeCandidatesForVlm(candidates) {
  return {
    relationCandidates: (candidates.relationCandidates || []).slice(0, 16).map((item) => ({
      candidateId: item.candidateId,
      partAId: item.partAId,
      partBId: item.partBId,
      relationType: item.relationType,
      score: item.score,
      ruleEvidence: (item.ruleEvidence || []).slice(0, 4),
    })),
    baseCandidates: (candidates.baseCandidates || []).slice(0, 10).map((item) => ({
      partId: item.partId,
      score: item.score,
      reasons: (item.reasons || []).slice(0, 4),
    })),
    subassemblyCandidates: (candidates.subassemblyCandidates || []).slice(0, 8).map((item) => ({
      candidateId: item.candidateId,
      partIds: item.partIds,
      score: item.score,
      reasons: (item.reasons || []).slice(0, 4),
    })),
    graspCandidates: (candidates.graspCandidates || []).slice(0, 12).map((item) => ({
      candidateId: item.candidateId,
      partId: item.partId,
      faceIds: item.featureGroup?.faceIds || [],
      score: item.score,
    })),
  };
}

function collectEvidenceImages(bundle, payload = {}) {
  const result = [];
  const seen = new Set();

  function pushImage(dataUrl, label) {
    if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      return;
    }
    if (seen.has(dataUrl)) {
      return;
    }
    seen.add(dataUrl);
    result.push({ dataUrl, label });
  }

  const firstImageByCategory = [
    ["globalBeautyViews", "global-beauty"],
    ["globalPartMaskViews", "global-part-mask"],
    ["localOverlayViews", "local-overlay"],
    ["localFaceMaskViews", "local-face-mask"],
    ["sectionViews", "section"],
  ];

  firstImageByCategory.forEach(([category, label]) => {
    const dataUrl = bundle?.images?.[category]?.[0]?.dataUrl;
    pushImage(dataUrl, label);
  });

  pushImage(payload?.localVisualEvidence?.overlayDataUrl, "local-overlay-from-step");
  pushImage(payload?.localVisualEvidence?.faceMaskDataUrl, "local-face-mask-from-step");
  pushImage(payload?.stepPreviewDataUrl, "step-preview");

  return result.slice(0, 10);
}

function buildVlmUserPrompt({ contextSummary, candidateSummary, selection, evidenceTarget, reasoningSnapshot }) {
  return [
    "请基于以下 CAD 装配上下文执行分析，并输出可联动 3D viewer 的流程 JSON。",
    "重点：",
    "1. 给出 3~8 个分析阶段，timeline 需要可用于界面左侧流程展示。",
    "2. 每个阶段尽量给出 basePartId / assemblingPartId / focusPartIds，用于右侧模型联动高亮。",
    "3. 如果判断存在插入方向，请输出 insertionAxis。",
    "",
    "结构化上下文：",
    JSON.stringify(contextSummary, null, 2),
    "",
    "候选摘要：",
    JSON.stringify(candidateSummary, null, 2),
    "",
    "当前 UI 选择态：",
    JSON.stringify(selection || {}, null, 2),
    "",
    "本轮证据目标：",
    JSON.stringify(evidenceTarget || {}, null, 2),
    "",
    "本地推理快照（可作为先验）：",
    JSON.stringify(reasoningSnapshot || {}, null, 2),
  ].join("\n");
}

function normalizeUsage(usage = {}) {
  return {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    raw: usage,
  };
}

function mergeUsageSummary(summary, usage = {}) {
  const next = {
    inputTokens: summary?.inputTokens || 0,
    outputTokens: summary?.outputTokens || 0,
    totalTokens: summary?.totalTokens || 0,
    reasoningTokens: summary?.reasoningTokens || 0,
    cachedTokens: summary?.cachedTokens || 0,
    rounds: Array.isArray(summary?.rounds) ? summary.rounds : [],
  };
  const normalized = normalizeUsage(usage);
  next.inputTokens += normalized.inputTokens || 0;
  next.outputTokens += normalized.outputTokens || 0;
  next.totalTokens += normalized.totalTokens || 0;
  next.reasoningTokens += normalized.reasoningTokens || 0;
  next.cachedTokens += normalized.cachedTokens || 0;
  next.rounds.push(normalized);
  return next;
}

function normalizeAgentDecision(parsed = {}) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const toolCall = payload.tool_call || payload.toolCall || null;
  const mode =
    payload.mode === "tool" || payload.mode === "final"
      ? payload.mode
      : toolCall
        ? "tool"
        : "final";

  return {
    mode,
    stageTitle: String(payload.stage_title || payload.stageTitle || payload.title || "分析阶段"),
    stageGoal: String(payload.stage_goal || payload.stageGoal || payload.goal || ""),
    rationale: String(payload.rationale || payload.reason || payload.detail || ""),
    toolCall:
      toolCall && typeof toolCall === "object"
        ? {
            name: String(toolCall.name || toolCall.tool || ""),
            arguments: toolCall.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : {},
          }
        : null,
    final: payload.final && typeof payload.final === "object" ? payload.final : payload,
  };
}

function normalizeToolName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  const aliases = {
    focus_parts: "focus_parts",
    focusparts: "focus_parts",
    isolate_parts: "focus_parts",
    isolateparts: "focus_parts",
    hide_parts: "hide_parts",
    hideparts: "hide_parts",
    set_part_opacity: "set_part_opacity",
    setopacity: "set_part_opacity",
    set_face_map: "set_face_map",
    setfacemap: "set_face_map",
    face_map: "set_face_map",
    move_parts: "move_parts",
    moveparts: "move_parts",
    reset_display: "reset_display",
    resetdisplay: "reset_display",
    reset_translation: "reset_translation",
    resettranslation: "reset_translation",
    capture_views: "capture_views",
    captureviews: "capture_views",
    screenshot: "capture_views",
  };
  return aliases[normalized] || null;
}

function sanitizeToolPartIds(details, partIds = []) {
  const validPartIds = new Set(
    (details.assembly?.nodes || [])
      .filter((node) => node.kind === "part")
      .map((node) => node.id),
  );

  return unique(partIds).filter((partId) => validPartIds.has(partId));
}

function sanitizeCapturePresets(presets = []) {
  const allowed = new Set(["front", "left", "top", "right", "back", "bottom", "iso"]);
  const normalized = unique((Array.isArray(presets) ? presets : [presets]).map((item) => String(item || "").toLowerCase()))
    .filter((item) => allowed.has(item));
  return normalized.length ? normalized.slice(0, 4) : ["iso"];
}

function sanitizeAgentToolCall(details, decision) {
  const toolName = normalizeToolName(decision?.toolCall?.name);
  if (!toolName) {
    throw new Error("智能体返回了未知工具名。");
  }

  const rawArgs = decision?.toolCall?.arguments || {};
  const partIds = sanitizeToolPartIds(
    details,
    rawArgs.part_ids || rawArgs.partIds || rawArgs.focusPartIds || [],
  );

  if (["focus_parts", "hide_parts", "set_part_opacity", "set_face_map", "move_parts"].includes(toolName) && !partIds.length) {
    throw new Error(`工具 ${toolName} 缺少有效 part_ids。`);
  }

  switch (toolName) {
    case "capture_views":
      return {
        name: toolName,
        arguments: {
          presets: sanitizeCapturePresets(rawArgs.presets || rawArgs.views || []),
          mode: ["beauty", "face-mask", "id-mask"].includes(String(rawArgs.mode || "").toLowerCase())
            ? String(rawArgs.mode).toLowerCase()
            : "beauty",
        },
      };
    case "focus_parts":
    case "hide_parts":
    case "set_face_map":
      return {
        name: toolName,
        arguments: {
          partIds,
        },
      };
    case "set_part_opacity":
      return {
        name: toolName,
        arguments: {
          partIds,
          opacity: clamp(toFiniteNumber(rawArgs.opacity, 1), 0.05, 1),
        },
      };
    case "move_parts": {
      const direction = normalizeVector(
        rawArgs.direction || {
          x: rawArgs.x,
          y: rawArgs.y,
          z: rawArgs.z,
        },
      );
      const distance = Math.abs(toFiniteNumber(rawArgs.distance, 0));
      if (!distance) {
        throw new Error("move_parts 缺少有效 distance。");
      }
      return {
        name: toolName,
        arguments: {
          partIds,
          direction,
          distance,
        },
      };
    }
    case "reset_display":
      return {
        name: toolName,
        arguments: {},
      };
    case "reset_translation":
      return {
        name: toolName,
        arguments: {
          partIds,
        },
      };
    default:
      throw new Error(`未支持的工具：${toolName}`);
  }
}

function summarizeRendererState(statePayload = {}) {
  return {
    displayMode: statePayload.displayMode || "beauty",
    isolation: statePayload.isolation || [],
    faceMapTargetPartIds: statePayload.faceMapTargetPartIds || [],
    translations: statePayload.translations || {},
  };
}

function extractCaptureImages(captureResult, labelPrefix = "observation") {
  const images = [];
  if (captureResult?.dataUrl) {
    images.push({
      label: labelPrefix,
      dataUrl: captureResult.dataUrl,
      preset: captureResult.preset || null,
    });
  }

  if (Array.isArray(captureResult?.views)) {
    captureResult.views.forEach((view) => {
      if (!view?.dataUrl) {
        return;
      }
      images.push({
        label: `${labelPrefix}-${view.preset || "view"}`,
        dataUrl: view.dataUrl,
        preset: view.preset || null,
      });
    });
  }

  return images.slice(0, 2);
}

function buildAgentToolInitialPrompt({
  userInstruction,
  conversationHistory,
  contextSummary,
  candidateSummary,
  selection,
  reasoningSnapshot,
  currentDisplayState,
}) {
  return [
    "请先理解用户指令，再观察当前装配体，并决定下一步使用哪个显示控制工具。",
    "你会在每次工具调用后收到新的观察图像。",
    "",
    "用户指令：",
    String(userInstruction || "请对当前装配体进行分析，并完成用户请求。"),
    "",
    "对话历史摘要：",
    JSON.stringify(conversationHistory || [], null, 2),
    "",
    "模型上下文：",
    JSON.stringify(contextSummary, null, 2),
    "",
    "候选摘要：",
    JSON.stringify(candidateSummary, null, 2),
    "",
    "当前选择：",
    JSON.stringify(selection || {}, null, 2),
    "",
    "当前显示状态：",
    JSON.stringify(currentDisplayState || {}, null, 2),
    "",
    "本地推理快照：",
    JSON.stringify(reasoningSnapshot || {}, null, 2),
  ].join("\n");
}

function buildAgentToolFollowupPrompt({
  userInstruction,
  stepIndex,
  stageTitle,
  stageGoal,
  rationale,
  toolCall,
  toolResult,
  currentDisplayState,
}) {
  return [
    `第 ${stepIndex} 步工具执行完成。`,
    `用户指令：${String(userInstruction || "请完成用户任务。")}`,
    `阶段标题：${stageTitle || "-"}`,
    `阶段目标：${stageGoal || "-"}`,
    `阶段原因：${rationale || "-"}`,
    `工具：${toolCall.name}`,
    `工具参数：${JSON.stringify(toolCall.arguments || {}, null, 2)}`,
    "工具执行结果：",
    JSON.stringify(toolResult || {}, null, 2),
    "",
    "当前显示状态：",
    JSON.stringify(currentDisplayState || {}, null, 2),
    "",
    "如果你已经得到足够信息，可以输出 final；否则继续调用一个工具。",
  ].join("\n");
}

async function captureAgentObservation(projectId, labelPrefix = "agent") {
  await ensureRendererWorkbench(projectId);
  const captureResult = await requestRendererCapture({
    projectId,
    mode: "beauty",
    presets: ["iso", "front"],
    width: 960,
    height: 720,
    fit: true,
  });

  return {
    captureResult,
    images: extractCaptureImages(captureResult, labelPrefix),
  };
}

async function executeAgentDisplayTool(projectId, toolCall) {
  switch (toolCall.name) {
    case "capture_views": {
      const captureResult = await requestRendererCapture({
        projectId,
        mode: toolCall.arguments.mode,
        presets: toolCall.arguments.presets,
        width: 960,
        height: 720,
        fit: true,
      });
      return {
        type: "capture_views",
        captureResult,
        rendererState: getRendererState(),
      };
    }
    case "focus_parts":
      return {
        type: "display",
        rendererState: await requestRendererCommand({
          action: "agent-focus-parts",
          projectId,
          partIds: toolCall.arguments.partIds,
          timeoutMs: 30000,
        }),
      };
    case "hide_parts":
      return {
        type: "display",
        rendererState: await requestRendererCommand({
          action: "agent-hide-parts",
          projectId,
          partIds: toolCall.arguments.partIds,
          timeoutMs: 30000,
        }),
      };
    case "set_part_opacity":
      return {
        type: "display",
        rendererState: await requestRendererCommand({
          action: "agent-set-opacity",
          projectId,
          partIds: toolCall.arguments.partIds,
          opacity: toolCall.arguments.opacity,
          timeoutMs: 30000,
        }),
      };
    case "set_face_map":
      return {
        type: "display",
        rendererState: await requestRendererCommand({
          action: "agent-set-face-map",
          projectId,
          partIds: toolCall.arguments.partIds,
          timeoutMs: 30000,
        }),
      };
    case "move_parts":
      return {
        type: "display",
        rendererState: await requestRendererCommand({
          action: "agent-translate-parts",
          projectId,
          partIds: toolCall.arguments.partIds,
          direction: toolCall.arguments.direction,
          distance: toolCall.arguments.distance,
          timeoutMs: 30000,
        }),
      };
    case "reset_display":
      return {
        type: "display",
        rendererState: await requestRendererCommand({
          action: "agent-reset-display",
          projectId,
          timeoutMs: 30000,
        }),
      };
    case "reset_translation":
      return {
        type: "display",
        rendererState: await requestRendererCommand({
          action: "agent-reset-translation-parts",
          projectId,
          partIds: toolCall.arguments.partIds,
          timeoutMs: 30000,
        }),
      };
    default:
      throw new Error(`未知工具调用：${toolCall.name}`);
  }
}

async function callVlmJsonCompletion({ apiKey, baseUrl, model, timeoutMs, messages }) {
  if (typeof fetch !== "function") {
    throw new Error("当前运行时不支持 fetch，无法调用 VLM。");
  }

  const endpoint = `${trimTrailingSlash(baseUrl)}/chat/completions`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(rawText);
    } catch (_error) {
      throw new Error(`VLM 返回了非 JSON 响应：${rawText.slice(0, 320)}`);
    }

    if (!response.ok) {
      const errorMessage = payload?.error?.message || rawText || `HTTP ${response.status}`;
      throw new Error(`VLM 请求失败 (${response.status})：${errorMessage}`);
    }

    const choiceMessage = payload?.choices?.[0]?.message || {};
    const text = extractMessageText(choiceMessage.content);
    const parsed = tryParseJsonText(text);
    if (!parsed) {
      throw new Error(`VLM 未返回可解析 JSON：${text.slice(0, 320)}`);
    }

    return {
      raw: payload,
      text,
      parsed,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`VLM 请求超时（>${Math.round(timeoutMs / 1000)}s）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function resolveRelationCandidateIdFromSelection(selection, candidates) {
  const basePartId = selection?.basePartId;
  const assemblingPartId = selection?.assemblingPartId;
  if (!basePartId || !assemblingPartId) {
    return null;
  }

  const match = (candidates?.relationCandidates || []).find((item) => {
    const forward = item.partAId === basePartId && item.partBId === assemblingPartId;
    const reverse = item.partAId === assemblingPartId && item.partBId === basePartId;
    return forward || reverse;
  });
  return match?.candidateId || null;
}

function resolveProjectRoot() {
  if (app.isPackaged) {
    return path.join(app.getPath("userData"), "project-data");
  }

  return path.join(__dirname, "project-data");
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1280,
    minHeight: 820,
    backgroundColor: "#0f141b",
    title: "STEP Workbench MVP",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  setWindowProvider(() => mainWindow);
}


function broadcastMcpServerStatus(status) {
  currentMcpServerStatus = {
    ...currentMcpServerStatus,
    ...(status || {}),
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("mcp:server-status", currentMcpServerStatus);
  }
}

function broadcastProjectUpdate(project) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("projects:updated", project);
  }
}

function broadcastVlmAgentProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("vlm:agent-progress", payload);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRendererWorkbench(projectId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const rendererState = getRendererState();
    if (rendererState?.route === "workbench" && rendererState?.currentProjectId === projectId) {
      return rendererState;
    }
    await sleep(250);
  }
  throw new Error(`Renderer did not enter workbench for project ${projectId} within ${timeoutMs}ms.`);
}

async function ensureRendererWorkbench(projectId) {
  if (!projectId) {
    return null;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Main window is not available.");
  }

  const rendererState = getRendererState();
  if (rendererState?.route === "workbench" && rendererState?.currentProjectId === projectId) {
    return rendererState;
  }

  await mainWindow.webContents.executeJavaScript(
    `window.location.hash = ${JSON.stringify(`#/workbench/${projectId}`)};`,
    true,
  );

  return waitForRendererWorkbench(projectId);
}

async function saveScreenshot({ projectName, dataUrl }) {
  if (!dataUrl || !dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("截图数据无效，无法保存。");
  }

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "导出当前视图截图",
    defaultPath: `${projectName || "step-view"}-${Date.now()}.png`,
    filters: [{ name: "PNG Image", extensions: ["png"] }],
  });

  if (canceled || !filePath) {
    return { canceled: true };
  }

  const base64 = dataUrl.replace("data:image/png;base64,", "");
  await fs.writeFile(filePath, Buffer.from(base64, "base64"));
  return { canceled: false, filePath };
}

async function getReasoningProjectDetails(projectId) {
  const details = await getProjectDetails(projectId);
  if (!details?.manifest) {
    throw new Error("Project not found.");
  }
  if (details.manifest.status !== "ready" || !details.assembly) {
    throw new Error("Project is not ready for reasoning.");
  }
  return details;
}

async function runVlmAgentAnalysis(payload = {}) {
  const details = await getReasoningProjectDetails(payload?.projectId);
  const projectId = details.manifest.projectId;
  const config = resolveVlmConfig(payload || {});
  const userInstruction = String(payload?.instruction || "").trim();
  const conversationHistory = Array.isArray(payload?.conversationHistory)
    ? payload.conversationHistory
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: String(item.content || "").trim(),
        }))
        .filter((item) => item.content)
        .slice(-8)
    : [];
  const modelContext = buildModelContext(details, {
    includeFaces: false,
    maxFaceCountPerPart: 80,
    maxDepth: 6,
  });
  const candidates = buildAnalysisCandidates(details, {
    topK: 24,
    facePairLimit: 6,
  });
  const selection = payload?.selection || {};
  const contextSummary = summarizeModelContextForVlm(modelContext);
  const candidateSummary = summarizeCandidatesForVlm(candidates);
  const processLog = [];
  const toolStages = [];
  let usageSummary = null;
  let toolCallCount = 0;
  const emitProgress = (extra = {}) => {
    broadcastVlmAgentProgress({
      projectId,
      status: extra.status || "running",
      model: config.model,
      instruction: userInstruction,
      processLog,
      toolStages,
      ...extra,
    });
  };

  await ensureRendererWorkbench(projectId);
  const initialDisplayState = getRendererState();
  const initialObservation = await captureAgentObservation(projectId, "initial");

  const messages = [
    { role: "system", content: VLM_AGENT_TOOL_LOOP_PROMPT },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildAgentToolInitialPrompt({
            userInstruction,
            conversationHistory,
            contextSummary,
            candidateSummary,
            selection,
            reasoningSnapshot: payload?.reasoningSnapshot || null,
            currentDisplayState: summarizeRendererState(initialDisplayState),
          }),
        },
        ...initialObservation.images.map((image) => ({
          type: "image_url",
          image_url: {
            url: image.dataUrl,
          },
        })),
      ],
    },
  ];

  processLog.push({
    index: processLog.length + 1,
    type: "observation",
    title: "初始观察",
    detail: `载入 ${initialObservation.images.length} 张初始观察图。`,
    images: initialObservation.images.map((item) => item.label),
  });
  emitProgress({ startedAt: new Date().toISOString() });

  let finalPayload = null;

  for (let stepIndex = 0; stepIndex < MAX_VLM_AGENT_TOOL_STEPS; stepIndex += 1) {
    const completion = await callVlmJsonCompletion({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      messages,
    });
    usageSummary = mergeUsageSummary(usageSummary, completion.raw?.usage || {});
    const decision = normalizeAgentDecision(completion.parsed);

    messages.push({
      role: "assistant",
      content: completion.text,
    });

    processLog.push({
      index: processLog.length + 1,
      type: "decision",
      title: decision.stageTitle,
      detail: decision.rationale || decision.stageGoal || "智能体生成了下一步决策。",
      mode: decision.mode,
    });
    emitProgress();

    if (decision.mode === "final") {
      if (!toolCallCount) {
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "请至少先调用一次显示控制工具，再输出 final 结论。",
            },
          ],
        });
        processLog.push({
          index: processLog.length + 1,
          type: "system",
          title: "继续工具分析",
          detail: "系统要求在给出结论前至少先调用一次工具。",
        });
        emitProgress();
        continue;
      }

      finalPayload = decision.final;
      processLog.push({
        index: processLog.length + 1,
        type: "final",
        title: "最终结论",
        detail: String(decision.final?.summary || "智能体完成了最终分析输出。"),
      });
      emitProgress({ status: "finalizing" });
      break;
    }

    let toolCall = null;
    try {
      toolCall = sanitizeAgentToolCall(details, decision);
    } catch (error) {
      processLog.push({
        index: processLog.length + 1,
        type: "tool_error",
        title: "工具参数无效",
        detail: error?.message || String(error),
      });
      emitProgress();
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `上一步工具调用无效：${error?.message || String(error)}。请重新选择一个有效工具。`,
          },
        ],
      });
      continue;
    }
    processLog.push({
      index: processLog.length + 1,
      type: "tool_call",
      title: toolCall.name,
      detail: JSON.stringify(toolCall.arguments),
    });
    emitProgress();

    let toolResult = null;
    try {
      toolResult = await executeAgentDisplayTool(projectId, toolCall);
    } catch (error) {
      processLog.push({
        index: processLog.length + 1,
        type: "tool_error",
        title: toolCall.name,
        detail: error?.message || String(error),
      });
      emitProgress();
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `工具 ${toolCall.name} 执行失败：${error?.message || String(error)}。请根据失败原因选择下一步工具。`,
          },
        ],
      });
      continue;
    }
    toolCallCount += 1;
    const currentDisplayState = summarizeRendererState(toolResult?.rendererState || getRendererState());
    const observation =
      toolCall.name === "capture_views"
        ? {
            captureResult: toolResult.captureResult,
            images: extractCaptureImages(toolResult.captureResult, `capture_${stepIndex + 1}`),
          }
        : await captureAgentObservation(projectId, `step_${stepIndex + 1}`);

    processLog.push({
      index: processLog.length + 1,
      type: "tool_result",
      title: toolCall.name,
      detail: `工具执行完成，返回 ${observation.images.length} 张观察图。`,
      images: observation.images.map((item) => item.label),
    });

    toolStages.push({
      stageId: `tool_stage_${stepIndex + 1}`,
      title: decision.stageTitle || `阶段 ${stepIndex + 1}`,
      goal: decision.stageGoal || "",
      detail: decision.rationale || currentDisplayState.displayMode || "",
      toolName: toolCall.name,
      toolArguments: toolCall.arguments,
      focusPartIds: toolCall.arguments.partIds || [],
      basePartId: toolCall.arguments.partIds?.[0] || null,
      assemblingPartId: toolCall.arguments.partIds?.[1] || null,
      observationLabels: observation.images.map((item) => item.label),
    });
    emitProgress();

    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: buildAgentToolFollowupPrompt({
            userInstruction,
            stepIndex: stepIndex + 1,
            stageTitle: decision.stageTitle,
            stageGoal: decision.stageGoal,
            rationale: decision.rationale,
            toolCall,
            toolResult: {
              displayState: currentDisplayState,
            },
            currentDisplayState,
          }),
        },
        ...observation.images.map((image) => ({
          type: "image_url",
          image_url: {
            url: image.dataUrl,
          },
        })),
      ],
    });
  }

  if (!finalPayload) {
    const completion = await callVlmJsonCompletion({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      messages: [
        ...messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请立即结束分析，并返回 mode=final 的 JSON。",
            },
          ],
        },
      ],
    });
    usageSummary = mergeUsageSummary(usageSummary, completion.raw?.usage || {});
    const decision = normalizeAgentDecision(completion.parsed);
    finalPayload = decision.final;
    processLog.push({
      index: processLog.length + 1,
      type: "final",
      title: "最终结论",
      detail: "智能体完成了最终分析输出。",
    });
    emitProgress({ status: "finalizing" });
  }

  const normalized = normalizeVlmOutput(finalPayload);
  emitProgress({
    status: "ready",
    summary: normalized.summary,
    timeline: normalized.timeline.length ? normalized.timeline : toolStages,
    suggestions: normalized.suggestions,
  });

  return {
    projectId,
    projectName: details.manifest.projectName,
    model: config.model,
    endpoint: `${config.baseUrl}/chat/completions`,
    generatedAt: new Date().toISOString(),
    instruction: userInstruction,
    summary: normalized.summary,
    confidence: normalized.confidence,
    focus: normalized.focus,
    timeline: normalized.timeline.length ? normalized.timeline : toolStages,
    suggestions: normalized.suggestions,
    usage: usageSummary,
    evidence: {
      target: null,
      imageCount:
        initialObservation.images.length +
        toolStages.reduce((sum, item) => sum + (item.observationLabels?.length || 0), 0),
      imageLabels: [
        ...initialObservation.images.map((item) => item.label),
        ...toolStages.flatMap((item) => item.observationLabels || []),
      ],
      captureWarning: null,
    },
    contextStats: {
      partCount: details.manifest.partCount || 0,
      faceCount: details.manifest.faceCount || 0,
      relationCandidateCount: candidates.relationCandidates?.length || 0,
      baseCandidateCount: candidates.baseCandidates?.length || 0,
      subassemblyCandidateCount: candidates.subassemblyCandidates?.length || 0,
      graspCandidateCount: candidates.graspCandidates?.length || 0,
      toolCallCount,
    },
    processLog,
    toolStages,
    raw: finalPayload,
  };
}

function registerIpcHandlers() {
  ipcMain.on("mcp:state:update", (_event, payload) => {
    updateRendererState(payload || {});
  });

  ipcMain.on("mcp:capture:response", (_event, payload) => {
    handleCaptureResponse(payload || {});
  });

  ipcMain.on("mcp:command:response", (_event, payload) => {
    handleCommandResponse(payload || {});
  });

  ipcMain.handle("system:pick-step-files", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "导入 STEP 装配模型",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "STEP", extensions: ["step", "stp"] }],
    });

    return canceled ? [] : filePaths;
  });

  ipcMain.handle("projects:list", async () => {
    return listProjects();
  });

  ipcMain.handle("projects:import", async (_event, payload) => {
    const filePaths = Array.from(new Set(payload?.filePaths || []));
    const results = await Promise.all(
      filePaths.map(async (filePath) => {
        try {
          const project = await importProjectFromFile(filePath);
          return { ok: true, project };
        } catch (error) {
          return { ok: false, filePath, error: error.message };
        }
      }),
    );

    return results;
  });

  ipcMain.handle("projects:details", async (_event, projectId) => {
    return getProjectDetails(projectId);
  });

  ipcMain.handle("projects:retry", async (_event, projectId) => {
    return retryProject(projectId);
  });

  ipcMain.handle("projects:rename", async (_event, payload) => {
    return renameProject(payload?.projectId, payload?.name);
  });

  ipcMain.handle("projects:delete", async (_event, projectId) => {
    return deleteProject(projectId);
  });

  ipcMain.handle("projects:open-source-dir", async (_event, projectId) => {
    const manifest = await getProjectManifest(projectId);
    if (!manifest) {
      throw new Error("项目不存在。");
    }

    const targetPath = manifest.sourceFilePath || getProjectDirectory(projectId);
    shell.showItemInFolder(targetPath);
    return { ok: true };
  });

  ipcMain.handle("system:save-screenshot", async (_event, payload) => {
    return saveScreenshot(payload || {});
  });

  ipcMain.handle("mcp:server-status:get", async () => {
    return currentMcpServerStatus;
  });

  ipcMain.handle("vlm:analyze", async (_event, payload) => {
    return runVlmAgentAnalysis(payload || {});
  });

  ipcMain.handle("reasoning:summary", async (_event, projectId) => {
    const details = await getReasoningProjectDetails(projectId);
    return buildReasoningSummary(details);
  });

  ipcMain.handle("reasoning:constraints", async (_event, payload) => {
    const details = await getReasoningProjectDetails(payload?.projectId);
    return buildReasoningConstraints(details, payload || {});
  });

  ipcMain.handle("reasoning:transform", async (_event, payload) => {
    const details = await getReasoningProjectDetails(payload?.projectId);
    return buildReasoningTransform(details, payload || {});
  });

  ipcMain.handle("reasoning:plan", async (_event, payload) => {
    const details = await getReasoningProjectDetails(payload?.projectId);
    return buildReasoningPlan(details, payload || {});
  });

  ipcMain.handle("reasoning:step", async (_event, payload) => {
    const details = await getReasoningProjectDetails(payload?.projectId);
    return buildReasoningStep(details, payload || {});
  });

  ipcMain.handle("reasoning:step-preview", async (_event, payload) => {
    const details = await getReasoningProjectDetails(payload?.projectId);
    const step = buildReasoningStep(details, payload || {});
    return requestRendererCommand({
      action: "capture-step-preview",
      projectId: details.manifest.projectId,
      step,
      width: payload?.width,
      height: payload?.height,
      fit: payload?.fit,
    });
  });
}

app.whenReady().then(async () => {
  configureProjectRoot(resolveProjectRoot());
  await ensureProjectStore();
  onProjectUpdate(broadcastProjectUpdate);
  registerIpcHandlers();
  createMainWindow();

  try {
    mcpServerHandle = await startMcpHttpServer(
      {
        async listProjects() {
          return listProjects();
        },
        async getProjectDetails(projectId) {
          return getProjectDetails(projectId);
        },
        async getRendererState() {
          return getRendererState();
        },
        async captureRenderer(options) {
          if (options?.projectId) {
            await ensureRendererWorkbench(options.projectId);
          }
          return requestRendererCapture(options);
        },
        async executeRendererCommand(options) {
          if (options?.projectId) {
            await ensureRendererWorkbench(options.projectId);
          }
          return requestRendererCommand(options);
        },
      },
      {
        host: "127.0.0.1",
        port: 3765,
      },
    );

    broadcastMcpServerStatus({
      ok: true,
      host: mcpServerHandle.host,
      preferredPort: mcpServerHandle.preferredPort,
      port: mcpServerHandle.port,
      usedFallbackPort: mcpServerHandle.usedFallbackPort,
      error: "",
    });
  } catch (error) {
    console.error("Failed to start MCP HTTP server:", error);
    broadcastMcpServerStatus({
      ok: false,
      host: "127.0.0.1",
      preferredPort: 3765,
      port: null,
      usedFallbackPort: false,
      error: error?.message || String(error),
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (mcpServerHandle) {
    try {
      await mcpServerHandle.close();
    } catch (_error) {
      // Ignore server close errors during app shutdown.
    }
  }
});
