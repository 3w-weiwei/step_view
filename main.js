const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { randomUUID } = require("crypto");
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
  buildModelContextToolPayload,
  buildAnalysisCandidates,
  buildRelationCandidatesToolPayload,
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
  "你是一个用于 CAD 装配分析的 VLM 智能体。",
  "你的核心目标是：基于模型上下文 + 图像证据，识别关键装配关系并给出可执行结论。",
  "请只返回 JSON 对象，不要返回 Markdown。",
  "不要求固定 JSON 模板，但建议包含：summary、confidence、focus、timeline、suggestions。",
  "focus / timeline 中涉及的 partId 与 faceId 必须来自输入上下文，不可杜撰。",
  "如果信息不足，请在结论中明确不确定点，并给出下一步建议。",
].join("\n");
const VLM_AGENT_TOOL_LOOP_PROMPT = [
  "你是一个 CAD 装配分析智能体，目标是借助 VLM + 工具调用完成模型分析。",
  "重点不是拼凑固定 JSON 模板，而是高质量完成观察 -> 缩小范围 -> 验证关系 -> 输出结论。",
  "每一轮只返回 JSON（禁止 Markdown / 解释性前后缀）。",
  "可用工具：",
  '1. focus_parts: {\"part_ids\":[\"partId\"]} 聚焦指定零件。',
  '2. hide_parts: {\"part_ids\":[\"partId\"]} 隐藏指定零件。',
  '3. set_part_opacity: {\"part_ids\":[\"partId\"],\"opacity\":0.05-1} 调整指定零件透明度。',
  '4. set_face_map: {\"part_ids\":[\"partId\"]} 仅对指定零件显示面映射。',
  '5. move_parts: {\"part_ids\":[\"partId\"],\"direction\":{\"x\":0,\"y\":0,\"z\":1},\"distance\":10} 沿指定方向移动零件。',
  '6. reset_display: {} 恢复默认显示状态。',
  '7. reset_translation: {\"part_ids\":[\"partId\"]} 或 {} 恢复零件默认位置。',
  '8. capture_views: {"presets":["front","left","top","right","back","bottom","iso"]?,"mode":"beauty"|"face-mask"|"id-mask","fit":false,"current_view":true} 获取截图（presets 可省略；current_view=true 时抓取当前视角）。',
  '9. get_model_context: {\"part_ids\":[\"partId\"],\"max_depth\":3,\"include_faces\":false,\"max_face_count_per_part\":24,\"summary_only\":true} 获取模型上下文（优先摘要）。',
  '10. get_relation_candidates: {\"part_ids\":[\"partId\"],\"top_k\":8,\"candidate_types\":[\"relation\",\"base\",\"subassembly\",\"grasp\"],\"include_evidence\":false,\"evidence_limit\":4} 获取候选关系。',
  "输出格式（保持简洁，不要冗余字段）：",
  "1) 工具轮：{ mode: tool, stage_title, stage_goal, rationale, tool_call: { name, arguments } }",
  "2) 结束轮：{ mode: final, stage_title, stage_goal, rationale, final: { summary, confidence, focus, timeline, suggestions } }",
  "规则：",
  "- 至少调用一次工具后再输出 final。",
  "- 每次 mode=tool 只能调用一个工具。",
  "- partId / faceId 必须来自已给上下文，不可杜撰。",
  "- 信息不足时，在 final 中明确不确定性并给出下一步建议。",
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

function formatJsonlTimestamp(value = new Date()) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function sanitizeFileToken(value, fallback = "item") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function parseDataUrlImage(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  const mimeType = match[1];
  const base64 = match[2];
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";

  return {
    mimeType,
    base64,
    extension,
  };
}

async function createVlmConversationLogger({
  projectId,
  projectName,
  instruction,
  model,
  endpoint,
  conversationHistory,
  selection,
}) {
  const sessionId = randomUUID();
  const sessionTimestamp = formatJsonlTimestamp();
  const sessionDirectoryName = `${sessionTimestamp}-${sessionId}`;
  const logDirectory = path.join(getProjectDirectory(projectId), "agent-chat-logs");
  const sessionDirectory = path.join(logDirectory, sessionDirectoryName);
  const imagesDirectory = path.join(sessionDirectory, "images");
  const tracesDirectory = path.join(sessionDirectory, "traces");

  await fs.mkdir(imagesDirectory, { recursive: true });
  await fs.mkdir(tracesDirectory, { recursive: true });

  const logFilePath = path.join(sessionDirectory, "events.jsonl");
  const summaryFilePath = path.join(sessionDirectory, "summary.json");
  const traceFilePath = path.join(tracesDirectory, "agent-loop-trace.json");
  let writeQueue = Promise.resolve();
  let writeFailed = false;
  const savedImages = [];

  function enqueueWrite(task) {
    writeQueue = writeQueue
      .then(() => task())
      .catch((error) => {
        if (!writeFailed) {
          writeFailed = true;
          console.error("Failed to write VLM conversation artifacts:", error);
        }
      });
    return writeQueue;
  }

  function append(eventType, payload = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId,
      eventType,
      ...payload,
    };

    return enqueueWrite(() => fs.appendFile(logFilePath, JSON.stringify(entry) + "\n", "utf8"));
  }

  function writeJsonArtifact(relativePath, payload) {
    const targetPath = path.join(sessionDirectory, relativePath);
    return enqueueWrite(async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, JSON.stringify(payload, null, 2), "utf8");
    });
  }

  function saveImageDataUrl(dataUrl, options = {}) {
    const parsed = parseDataUrlImage(dataUrl);
    if (!parsed) {
      return Promise.resolve(null);
    }

    const step = Number.isFinite(Number(options.step)) ? Number(options.step) : 0;
    const kind = sanitizeFileToken(options.kind || "observation", "observation");
    const label = sanitizeFileToken(options.label || "", "image");
    const preset = sanitizeFileToken(options.preset || "", "view");
    const fileName = `${String(step).padStart(2, "0")}-${kind}-${label}-${preset}.${parsed.extension}`;
    const relativePath = path.join("images", fileName);
    const absolutePath = path.join(sessionDirectory, relativePath);

    return enqueueWrite(async () => {
      await fs.writeFile(absolutePath, Buffer.from(parsed.base64, "base64"));
      const imageMeta = {
        step,
        kind,
        label: options.label || "",
        preset: options.preset || null,
        mimeType: parsed.mimeType,
        path: relativePath.replace(/\\/g, "/"),
      };
      savedImages.push(imageMeta);
      return imageMeta;
    });
  }

  async function saveObservationImages(images = [], options = {}) {
    const list = Array.isArray(images) ? images : [];
    const results = [];
    for (let index = 0; index < list.length; index += 1) {
      const image = list[index] || {};
      const meta = await saveImageDataUrl(image.dataUrl, {
        step: options.step,
        kind: options.kind || "observation",
        label: image.label || `${options.kind || "observation"}-${index + 1}`,
        preset: image.preset || null,
      });
      if (meta) {
        results.push(meta);
      }
    }
    return results;
  }

  await append("session_start", {
    projectId,
    projectName,
    instruction,
    model,
    endpoint,
    conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
    selection: selection || {},
  });

  return {
    sessionId,
    sessionDirectory,
    logFilePath,
    summaryFilePath,
    traceFilePath,
    append,
    writeJsonArtifact,
    saveObservationImages,
    getSavedImages() {
      return [...savedImages];
    },
    flush() {
      return writeQueue;
    },
  };
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
    get_model_context: "get_model_context",
    getmodelcontext: "get_model_context",
    model_context: "get_model_context",
    get_relation_candidates: "get_relation_candidates",
    getrelationcandidates: "get_relation_candidates",
    relation_candidates: "get_relation_candidates",
    relationcandidates: "get_relation_candidates",
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

function sanitizeCapturePresets(presets = [], options = {}) {
  const allowed = new Set(["front", "left", "top", "right", "back", "bottom", "iso"]);
  const normalized = unique((Array.isArray(presets) ? presets : [presets]).map((item) => String(item || "").toLowerCase()))
    .filter((item) => allowed.has(item));
  if (normalized.length) {
    return normalized.slice(0, 4);
  }
  return options.allowEmpty ? [] : ["iso"];
}

function sanitizeAgentBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function sanitizeAgentCandidateTypes(rawCandidateTypes = [], rawArgs = {}) {
  const directTypes = Array.isArray(rawCandidateTypes) && rawCandidateTypes.length
    ? rawCandidateTypes
    : [
        "relation",
        sanitizeAgentBoolean(rawArgs.include_base_candidates ?? rawArgs.includeBaseCandidates, true) ? "base" : null,
        sanitizeAgentBoolean(rawArgs.include_subassembly_candidates ?? rawArgs.includeSubassemblyCandidates, true) ? "subassembly" : null,
        sanitizeAgentBoolean(rawArgs.include_grasp_candidates ?? rawArgs.includeGraspCandidates, true) ? "grasp" : null,
      ];
  const aliases = {
    relation: "relation",
    relations: "relation",
    base: "base",
    base_part: "base",
    basepart: "base",
    subassembly: "subassembly",
    subassemblies: "subassembly",
    grasp: "grasp",
    grasps: "grasp",
  };
  const normalized = unique((Array.isArray(directTypes) ? directTypes : [directTypes])
    .map((item) => aliases[String(item || "").trim().toLowerCase()] || null)
    .filter(Boolean));
  return normalized.length ? normalized : ["relation", "base", "subassembly", "grasp"];
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
    throw new Error("工具 " + toolName + " 缺少有效的 part_ids。");
  }

  switch (toolName) {
    case "get_model_context": {
      const requestedFaces = sanitizeAgentBoolean(rawArgs.include_faces ?? rawArgs.includeFaces, false);
      const summaryOnly =
        rawArgs.summary_only == null && rawArgs.summaryOnly == null
          ? !requestedFaces
          : sanitizeAgentBoolean(rawArgs.summary_only ?? rawArgs.summaryOnly, true);
      return {
        name: toolName,
        arguments: {
          partIds,
          maxDepth: clamp(Math.round(toFiniteNumber(rawArgs.max_depth ?? rawArgs.maxDepth, summaryOnly ? 3 : 5)), 1, 12),
          includeFaces: !summaryOnly && requestedFaces,
          maxFaceCountPerPart: clamp(Math.round(toFiniteNumber(rawArgs.max_face_count_per_part ?? rawArgs.maxFaceCountPerPart, 24)), 1, 256),
          summaryOnly,
        },
      };
    }
    case "get_relation_candidates":
      return {
        name: toolName,
        arguments: {
          partIds,
          topK: clamp(Math.round(toFiniteNumber(rawArgs.top_k ?? rawArgs.topK, 12)), 1, 64),
          candidateTypes: sanitizeAgentCandidateTypes(rawArgs.candidate_types || rawArgs.candidateTypes, rawArgs),
          includeEvidence: sanitizeAgentBoolean(rawArgs.include_evidence ?? rawArgs.includeEvidence, false),
          evidenceLimit: clamp(Math.round(toFiniteNumber(rawArgs.evidence_limit ?? rawArgs.evidenceLimit, 4)), 1, 12),
        },
      };
    case "capture_views":
      return {
        name: toolName,
        arguments: {
          presets: sanitizeCapturePresets(rawArgs.presets || rawArgs.views || [], {
            allowEmpty: sanitizeAgentBoolean(rawArgs.current_view ?? rawArgs.currentView, false),
          }),
          mode: ["beauty", "face-mask", "id-mask"].includes(String(rawArgs.mode || "").toLowerCase())
            ? String(rawArgs.mode).toLowerCase()
            : "beauty",
          fit: sanitizeAgentBoolean(rawArgs.fit, false),
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
        throw new Error("move_parts 缺少有效的 distance。");
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
      throw new Error("暂不支持的工具：" + toolName);
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

function summarizeObservationImagesForLog(images = []) {
  return (Array.isArray(images) ? images : []).map((item) => ({
    label: item?.label || "",
    preset: item?.preset || null,
  }));
}

function summarizeToolResultForLog(toolResult, currentDisplayState, observation) {
  if (toolResult?.type === "analysis") {
    return {
      type: "analysis",
      summary: toolResult.summary || "",
      payload: toolResult.payload || null,
      displayState: currentDisplayState || {},
    };
  }

  return {
    type: toolResult?.type || "display",
    displayState: currentDisplayState || {},
    observationImages: summarizeObservationImagesForLog(observation?.images),
  };
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
    "请先理解用户请求，再结合下面的轻量摘要选择下一步工具。",
    "推荐策略：先用 get_model_context / get_relation_candidates 的摘要模式缩小范围，锁定 2 到 6 个相关零件后再获取局部细节，只有在需要视觉确认时再调用显示工具。",
    "调用显示工具后你会收到新的图像，调用上下文工具后你会收到结构化 JSON 结果。",
    "",
    "用户指令：",
    String(userInstruction || "请分析当前装配体并完成任务。"),
    "",
    "对话历史摘要：",
    JSON.stringify(conversationHistory || [], null, 2),
    "",
    "模型上下文摘要：",
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

async function executeAgentTool(details, projectId, toolCall) {
  switch (toolCall.name) {
    case "get_model_context": {
      const payload = buildModelContextToolPayload(details, {
        partIds: toolCall.arguments.partIds,
        maxDepth: toolCall.arguments.maxDepth,
        includeFaces: toolCall.arguments.includeFaces,
        maxFaceCountPerPart: toolCall.arguments.maxFaceCountPerPart,
        summaryOnly: toolCall.arguments.summaryOnly,
      });
      return {
        type: "analysis",
        payload,
        summary: "已返回 " + payload.parts.length + " 个零件的模型上下文。",
        rendererState: getRendererState(),
      };
    }
    case "get_relation_candidates": {
      const payload = buildRelationCandidatesToolPayload(details, {
        partIds: toolCall.arguments.partIds,
        topK: toolCall.arguments.topK,
        candidateTypes: toolCall.arguments.candidateTypes,
        includeEvidence: toolCall.arguments.includeEvidence,
        evidenceLimit: toolCall.arguments.evidenceLimit,
      });
      const totalCount =
        (payload.relationCandidates?.length || 0) +
        (payload.baseCandidates?.length || 0) +
        (payload.subassemblyCandidates?.length || 0) +
        (payload.graspCandidates?.length || 0);
      return {
        type: "analysis",
        payload,
        summary: "已返回 " + totalCount + " 个候选项。",
        rendererState: getRendererState(),
      };
    }
    case "capture_views": {
      const captureResult = await requestRendererCapture({
        projectId,
        mode: toolCall.arguments.mode,
        presets: toolCall.arguments.presets,
        width: 960,
        height: 720,
        fit: toolCall.arguments.fit,
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
      throw new Error("Unknown tool call: " + toolCall.name);
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
  const projectName = details.manifest.projectName;
  const config = resolveVlmConfig(payload || {});
  const endpoint = `${config.baseUrl}/chat/completions`;
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
  const selection = payload?.selection || {};
  const logger = await createVlmConversationLogger({
    projectId,
    projectName,
    instruction: userInstruction,
    model: config.model,
    endpoint,
    conversationHistory,
    selection,
  }).catch((error) => {
    console.error("Failed to create VLM conversation logger:", error);
    return null;
  });
  const appendConversationLog = async (eventType, eventPayload = {}) => {
    if (!logger) {
      return;
    }
    await logger.append(eventType, eventPayload);
  };

  try {
  const modelContext = buildModelContext(details, {
    includeFaces: false,
    maxFaceCountPerPart: 80,
    maxDepth: 6,
  });
  const candidates = buildAnalysisCandidates(details, {
    topK: 24,
    facePairLimit: 6,
  });
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

  await appendConversationLog("session_context", {
    focusPartIds: Array.isArray(payload?.focusPartIds) ? payload.focusPartIds : [],
    focusFaceIds: Array.isArray(payload?.focusFaceIds) ? payload.focusFaceIds : [],
    baseFaceIds: Array.isArray(payload?.baseFaceIds) ? payload.baseFaceIds : [],
    assemblingFaceIds: Array.isArray(payload?.assemblingFaceIds) ? payload.assemblingFaceIds : [],
    reasoningSnapshot: payload?.reasoningSnapshot || null,
  });

  await ensureRendererWorkbench(projectId);
  const initialDisplayState = getRendererState();
  const initialObservation = await captureAgentObservation(projectId, "initial");
  const initialPromptText = buildAgentToolInitialPrompt({
    userInstruction,
    conversationHistory,
    contextSummary,
    candidateSummary,
    selection,
    reasoningSnapshot: payload?.reasoningSnapshot || null,
    currentDisplayState: summarizeRendererState(initialDisplayState),
  });

  const messages = [
    { role: "system", content: VLM_AGENT_TOOL_LOOP_PROMPT },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: initialPromptText,
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
  await appendConversationLog("initial_observation", {
    displayState: summarizeRendererState(initialDisplayState),
    imageLabels: summarizeObservationImagesForLog(initialObservation.images),
  });
  await appendConversationLog("llm_input", {
    round: 0,
    phase: "initial",
    text: initialPromptText,
    imageLabels: summarizeObservationImagesForLog(initialObservation.images),
  });

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
    await appendConversationLog("llm_output", {
      round: stepIndex + 1,
      text: completion.text,
      parsed: completion.parsed || null,
      decision,
      usage: normalizeUsage(completion.raw?.usage || {}),
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
        await appendConversationLog("final_blocked", {
          round: stepIndex + 1,
          reason: "系统要求至少先调用一次工具。",
        });
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
      await appendConversationLog("final_decision", {
        round: stepIndex + 1,
        final: finalPayload,
      });
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
      await appendConversationLog("tool_validation_error", {
        round: stepIndex + 1,
        message: error?.message || String(error),
        rawToolCall: decision?.toolCall || null,
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
    await appendConversationLog("tool_call", {
      round: stepIndex + 1,
      stageTitle: decision.stageTitle,
      stageGoal: decision.stageGoal,
      rationale: decision.rationale,
      toolCall,
    });

    let toolResult = null;
    try {
      toolResult = await executeAgentTool(details, projectId, toolCall);
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
      await appendConversationLog("tool_execution_error", {
        round: stepIndex + 1,
        toolCall,
        message: error?.message || String(error),
      });
      continue;
    }
    toolCallCount += 1;
    const currentDisplayState = summarizeRendererState(toolResult?.rendererState || getRendererState());
    const observation =
      toolResult.type === "capture_views"
        ? {
            captureResult: toolResult.captureResult,
            images: extractCaptureImages(toolResult.captureResult, "capture_" + (stepIndex + 1)),
          }
        : toolResult.type === "analysis"
          ? {
              captureResult: null,
              images: [],
              textPayload: toolResult.payload,
            }
          : await captureAgentObservation(projectId, "step_" + (stepIndex + 1));

    processLog.push({
      index: processLog.length + 1,
      type: "tool_result",
      title: toolCall.name,
      detail:
        toolResult.type === "analysis"
          ? (toolResult.summary || "Tool completed and returned structured data.")
          : "Tool completed and returned " + observation.images.length + " observation images.",
      images: observation.images.map((item) => item.label),
    });

    toolStages.push({
      stageId: "tool_stage_" + (stepIndex + 1),
      title: decision.stageTitle || ("Stage " + (stepIndex + 1)),
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
    await appendConversationLog("tool_result", {
      round: stepIndex + 1,
      toolName: toolCall.name,
      result: summarizeToolResultForLog(toolResult, currentDisplayState, observation),
      imageLabels: summarizeObservationImagesForLog(observation.images),
    });

    const followupPromptText = buildAgentToolFollowupPrompt({
      userInstruction,
      stepIndex: stepIndex + 1,
      stageTitle: decision.stageTitle,
      stageGoal: decision.stageGoal,
      rationale: decision.rationale,
      toolCall,
      toolResult:
        toolResult.type === "analysis"
          ? {
              analysis: toolResult.payload,
              displayState: currentDisplayState,
            }
          : {
              displayState: currentDisplayState,
            },
      currentDisplayState,
    });
    await appendConversationLog("llm_input", {
      round: stepIndex + 1,
      phase: "followup",
      text: followupPromptText,
      imageLabels: summarizeObservationImagesForLog(observation.images),
    });

    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: followupPromptText,
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
    const forcedFinalPrompt = "请立即结束分析，并返回 mode=final 的 JSON。";
    await appendConversationLog("llm_input", {
      round: MAX_VLM_AGENT_TOOL_STEPS + 1,
      phase: "forced_final",
      text: forcedFinalPrompt,
      imageLabels: [],
    });
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
              text: forcedFinalPrompt,
            },
          ],
        },
      ],
    });
    usageSummary = mergeUsageSummary(usageSummary, completion.raw?.usage || {});
    const decision = normalizeAgentDecision(completion.parsed);
    await appendConversationLog("llm_output", {
      round: MAX_VLM_AGENT_TOOL_STEPS + 1,
      text: completion.text,
      parsed: completion.parsed || null,
      decision,
      usage: normalizeUsage(completion.raw?.usage || {}),
    });
    finalPayload = decision.final;
    processLog.push({
      index: processLog.length + 1,
      type: "final",
      title: "最终结论",
      detail: "智能体完成了最终分析输出。",
    });
    emitProgress({ status: "finalizing" });
    await appendConversationLog("final_decision", {
      round: MAX_VLM_AGENT_TOOL_STEPS + 1,
      final: finalPayload,
    });
  }

  const normalized = normalizeVlmOutput(finalPayload);
  const timeline = normalized.timeline.length ? normalized.timeline : toolStages;
  const evidence = {
    target: null,
    imageCount:
      initialObservation.images.length +
      toolStages.reduce((sum, item) => sum + (item.observationLabels?.length || 0), 0),
    imageLabels: [
      ...initialObservation.images.map((item) => item.label),
      ...toolStages.flatMap((item) => item.observationLabels || []),
    ],
    captureWarning: null,
  };
  const contextStats = {
    partCount: details.manifest.partCount || 0,
    faceCount: details.manifest.faceCount || 0,
    relationCandidateCount: candidates.relationCandidates?.length || 0,
    baseCandidateCount: candidates.baseCandidates?.length || 0,
    subassemblyCandidateCount: candidates.subassemblyCandidates?.length || 0,
    graspCandidateCount: candidates.graspCandidates?.length || 0,
    toolCallCount,
  };
  emitProgress({
    status: "ready",
    summary: normalized.summary,
    timeline,
    suggestions: normalized.suggestions,
  });
  await appendConversationLog("session_final", {
    summary: normalized.summary,
    confidence: normalized.confidence,
    focus: normalized.focus,
    timeline,
    suggestions: normalized.suggestions,
    usage: usageSummary,
    evidence,
    contextStats,
    processLog,
    toolStages,
  });

  return {
    projectId,
    projectName,
    model: config.model,
    endpoint,
    generatedAt: new Date().toISOString(),
    instruction: userInstruction,
    summary: normalized.summary,
    confidence: normalized.confidence,
    focus: normalized.focus,
    timeline,
    suggestions: normalized.suggestions,
    usage: usageSummary,
    evidence,
    contextStats,
    processLog,
    toolStages,
    raw: finalPayload,
    logSessionId: logger?.sessionId || null,
    logFilePath: logger?.logFilePath || null,
  };
  } catch (error) {
    await appendConversationLog("session_error", {
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
    throw error;
  } finally {
    if (logger) {
      await logger.flush();
    }
  }
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
