import { WorkbenchViewer } from "./mesh-viewer.js";

const api = window.cadViewerApi;
const root = document.getElementById("app");
const dragMask = document.getElementById("drag-mask");

const STATUS_META = {
  pending: { label: "待处理", className: "status-pending" },
  parsing: { label: "解析中", className: "status-parsing" },
  ready: { label: "可打开", className: "status-ready" },
  failed: { label: "解析失败", className: "status-failed" },
};

const PANEL_META = {
  overview: {
    icon: "OV",
    title: "项目概览",
    description: "从项目级信息切入，确认模型来源、统计摘要和缓存状态。",
  },
  assembly: {
    icon: "AS",
    title: "装配树",
    description: "搜索零件、展开层级，并与 3D 主视图区保持联动高亮。",
  },
  display: {
    icon: "DP",
    title: "显示控制",
    description: "控制对象显隐与隔离范围，便于聚焦复杂装配中的局部区域。",
  },
  agent: {
    icon: "AG",
    title: "智能体流程",
    description: "在模型工作台中查看 VLM Agent 的工具调用过程、阶段和结论。",
  },
  section: {
    icon: "SC",
    title: "剖切分析",
    description: "使用单平面剖切观察内部结构，按轴向调整位置。",
  },
  measure: {
    icon: "MS",
    title: "测量工具",
    description: "在零件级与面级之间切换，完成距离、角度与边长的基础测量。",
  },
  properties: {
    icon: "PR",
    title: "属性信息",
    description: "查看当前选中对象的名称、路径、材质、尺寸与面信息摘要。",
  },
};
const REASONING_PANEL_META = {
  summary: {
    icon: "AI",
    title: "装配推理",
    description: "查看整体推理结果、当前焦点和分析刷新状态。",
  },
  constraints: {
    icon: "CT",
    title: "约束发现",
    description: "查看基准件候选、配合候选和插入方向。",
  },
  transform: {
    icon: "TF",
    title: "姿态校验",
    description: "查看相对位姿、插入方向和干涉校验结果。",
  },
  plan: {
    icon: "PL",
    title: "装配计划",
    description: "查看候选装配序列与 precedence 关系。",
  },
  steps: {
    icon: "ST",
    title: "步骤讲解",
    description: "查看单步解释、证据和 before/after 预览。",
  },
};

function createEmptyReasoningOverlay() {
  return {
    focusPartIds: [],
    basePartId: null,
    assemblingPartId: null,
    baseFaceIds: [],
    assemblingFaceIds: [],
    insertionAxis: null,
    interferenceBoxes: [],
  };
}

function createEmptyAgentAnalysisState(previous = null) {
  return {
    status: previous?.status || "idle",
    error: previous?.error || "",
    startedAt: previous?.startedAt || "",
    finishedAt: previous?.finishedAt || "",
    model: previous?.model || "",
    endpoint: previous?.endpoint || "",
    summary: previous?.summary || "",
    confidence: Number.isFinite(Number(previous?.confidence)) ? Number(previous.confidence) : 0,
    timeline: Array.isArray(previous?.timeline) ? previous.timeline : [],
    selectedTimelineIndex: Number.isFinite(Number(previous?.selectedTimelineIndex))
      ? Number(previous.selectedTimelineIndex)
      : -1,
    suggestions: Array.isArray(previous?.suggestions) ? previous.suggestions : [],
    usage: previous?.usage || null,
    evidence: previous?.evidence || null,
    contextStats: previous?.contextStats || null,
    processLog: Array.isArray(previous?.processLog) ? previous.processLog : [],
    toolStages: Array.isArray(previous?.toolStages) ? previous.toolStages : [],
    raw: previous?.raw || null,
    instruction: previous?.instruction || "",
    chatInput: previous?.chatInput || "",
    chatMessages: Array.isArray(previous?.chatMessages) ? previous.chatMessages : [],
    partQuery: previous?.partQuery || "",
    opacityValue: Number.isFinite(Number(previous?.opacityValue)) ? Number(previous.opacityValue) : 0.45,
    faceMapEnabled: Boolean(previous?.faceMapEnabled),
    moveDirectionX: Number.isFinite(Number(previous?.moveDirectionX)) ? Number(previous.moveDirectionX) : 0,
    moveDirectionY: Number.isFinite(Number(previous?.moveDirectionY)) ? Number(previous.moveDirectionY) : 0,
    moveDirectionZ: Number.isFinite(Number(previous?.moveDirectionZ)) ? Number(previous.moveDirectionZ) : 1,
    moveDistance: Number.isFinite(Number(previous?.moveDistance)) ? Number(previous.moveDistance) : 10,
  };
}

function createReasoningDataState(previousData = null) {
  return {
    summary: previousData?.summary || null,
    basePartCandidates: previousData?.basePartCandidates || [],
    matingCandidates: previousData?.matingCandidates || [],
    insertionCandidates: previousData?.insertionCandidates || [],
    selectedPair: previousData?.selectedPair || null,
    relativeTransform: previousData?.relativeTransform || null,
    interference: previousData?.interference || null,
    plan: previousData?.plan || null,
    stepExplanation: previousData?.stepExplanation || null,
    stepPreview: previousData?.stepPreview || null,
    stepPreviewError: previousData?.stepPreviewError || "",
    stepVisualEvidence: previousData?.stepVisualEvidence || null,
    stepVisualEvidenceError: previousData?.stepVisualEvidenceError || "",
    constraintsOverlay: previousData?.constraintsOverlay || createEmptyReasoningOverlay(),
    transformOverlay: previousData?.transformOverlay || createEmptyReasoningOverlay(),
    stepOverlay: previousData?.stepOverlay || createEmptyReasoningOverlay(),
    agentAnalysis: createEmptyAgentAnalysisState(previousData?.agentAnalysis),
  };
}

function createEmptyReasoningState(previousReasoning = null) {
  const previous = previousReasoning || null;
  return {
    status: previous?.status || "idle",
    error: previous?.error || "",
    refreshedAt: previous?.refreshedAt || "",
    data: createReasoningDataState(previous?.data),
    selection: {
      basePartId: previous?.selection?.basePartId || null,
      assemblingPartId: previous?.selection?.assemblingPartId || null,
      sequenceId: previous?.selection?.sequenceId || null,
      stepIndex: previous?.selection?.stepIndex || null,
      highlightedBaseFaceId: previous?.selection?.highlightedBaseFaceId || null,
      highlightedAssemblingFaceId: previous?.selection?.highlightedAssemblingFaceId || null,
    },
    overlay: previous?.overlay ? { ...createEmptyReasoningOverlay(), ...previous.overlay } : createEmptyReasoningOverlay(),
  };
}

const state = {
  projects: [],
  searchText: "",
  filterStatus: "all",
  openProjectMenuId: null,
  route: { page: "home", projectId: null },
  loadingProjectId: null,
  activeProject: null,
  workbench: null,
  viewer: null,
  mcpServerStatus: null,
  toasts: [],
  globalDragging: false,
};if (!api) {
  root.innerHTML = `
    <div class="loading-state">
      <div class="loading-card glass-panel">
        <h2>请通过 Electron 启动这个项目</h2>
        <p>当前页面依赖 preload 暴露的桌面能力，包括文件选择、本地缓存读写和截图导出。</p>
      </div>
    </div>
  `;
} else {
  bootstrap().catch((error) => {
    root.innerHTML = `
      <div class="loading-state">
        <div class="loading-card glass-panel">
          <h2>应用初始化失败</h2>
          <p>${escapeHtml(error.message)}</p>
        </div>
      </div>
    `;
  });
}
async function bootstrap() {
  state.projects = await api.listProjects();
  state.route = parseRoute();
  api.onProjectUpdate(handleProjectUpdate);
  api.onMcpServerStatus?.(handleMcpServerStatus);
  api.onVlmAgentProgress?.(handleVlmAgentProgress);
  registerMcpBridge();

  root.addEventListener("click", handleClick);
  root.addEventListener("input", handleInput);
  root.addEventListener("change", handleChange);
  window.addEventListener("hashchange", handleHashChange);
  window.addEventListener("dragover", handleWindowDragOver);
  window.addEventListener("dragleave", handleWindowDragLeave);
  window.addEventListener("drop", handleWindowDrop);
  window.addEventListener("beforeunload", () => state.viewer?.destroy());

  if (api.getMcpServerStatus) {
    handleMcpServerStatus(await api.getMcpServerStatus());
  }

  await syncRoute();
}
function handleMcpServerStatus(payload) {
  if (!payload) {
    return;
  }

  const previous = state.mcpServerStatus;
  state.mcpServerStatus = payload;

  if (!previous || previous.port !== payload.port || previous.ok !== payload.ok || previous.error !== payload.error) {
    if (payload.ok && payload.usedFallbackPort) {
      pushToast(`MCP 服务已切换到 ${payload.host}:${payload.port}`, "info");
    } else if (!payload.ok && payload.error) {
      pushToast(`MCP 服务启动失败：${payload.error}`, "error");
    }
  }
}

function handleVlmAgentProgress(payload) {
  if (!payload || !state.workbench || !state.activeProject) {
    return;
  }
  if (payload.projectId !== state.activeProject.manifest.projectId) {
    return;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  if (payload.status === "running" || payload.status === "finalizing") {
    agent.status = "running";
  } else if (payload.status === "ready") {
    agent.status = "ready";
  }
  if (payload.startedAt) {
    agent.startedAt = payload.startedAt;
  }
  if (payload.model) {
    agent.model = payload.model;
  }
  if (payload.instruction) {
    agent.instruction = payload.instruction;
  }
  if (Array.isArray(payload.processLog)) {
    agent.processLog = payload.processLog;
  }
  if (Array.isArray(payload.toolStages)) {
    agent.toolStages = payload.toolStages;
  }
  if (payload.summary) {
    agent.summary = payload.summary;
  }
  if (Array.isArray(payload.timeline) && !agent.timeline.length) {
    agent.timeline = payload.timeline;
  }
  if (Array.isArray(payload.suggestions) && !agent.suggestions.length) {
    agent.suggestions = payload.suggestions;
  }

  render({ preserveBoundInput: true });
}
function registerMcpBridge() {
  if (!api?.registerMcpCaptureHandler) {
    return;
  }

  api.registerMcpCaptureHandler(async (payload) => {
    if (state.route.page !== "workbench" || !state.viewer || !state.activeProject) {
      throw new Error("当前没有活动工作台，无法截图。");
    }

    const mode =
      payload?.mode === "id-mask"
        ? "id-mask"
        : payload?.mode === "face-mask"
          ? "face-mask"
          : "beauty";
    const capture = Array.isArray(payload?.presets) && payload.presets.length
      ? await state.viewer.captureMultiView(mode, {
          width: payload?.width,
          height: payload?.height,
          fit: payload?.fit,
          presets: payload?.presets,
          format: payload?.format,
          quality: payload?.quality,
        })
      : await state.viewer.capture(mode, {
          width: payload?.width,
          height: payload?.height,
          fit: payload?.fit,
          preset: payload?.preset,
          format: payload?.format,
          quality: payload?.quality,
        });

    return {
      ...capture,
      mode,
      projectId: state.activeProject.manifest.projectId,
      selection: state.workbench?.selection || null,
      section: state.workbench?.section || null,
      colorMap: capture.colorMap || [],
    };
  });

  if (api?.registerMcpCommandHandler) {
    api.registerMcpCommandHandler(async (payload) => {
      return executeMcpCommand(payload || {});
    });
  }
}
function buildMcpStatePayload() {
  return state.route.page === "workbench" && state.activeProject && state.workbench
    ? {
        route: state.route.page,
        currentProjectId: state.activeProject.manifest.projectId,
        projectName: state.activeProject.manifest.projectName,
        parserMode: state.activeProject.manifest.parserMode,
        geometryMode: state.activeProject.manifest.geometryMode,
        selection: state.workbench.selection || null,
        selectionMode: state.workbench.selectionMode,
        section: state.workbench.section || null,
        isolation: state.workbench.isolatedNodeIds ? Array.from(state.workbench.isolatedNodeIds) : [],
        displayMode: state.workbench.displayMode || "beauty",
        faceMapTargetPartIds: state.workbench.faceMapTargetPartIds || [],
        translations: state.workbench.nodeTranslationMap || {},
        camera: state.viewer?.snapshot?.() || null,
        colorMaps: {
          display: state.viewer?.getColorMap?.("display") || [],
          "id-mask": state.viewer?.getColorMap?.("id-mask") || [],
          "face-mask": state.viewer?.getColorMap?.("face-mask") || [],
        },
      }
    : {
        route: state.route.page,
        currentProjectId: null,
        selection: null,
        section: null,
        isolation: [],
        displayMode: "beauty",
        faceMapTargetPartIds: [],
        translations: {},
        camera: null,
        colorMaps: {
          display: [],
          "id-mask": [],
          "face-mask": [],
        },
      };
}

function publishMcpState() {
  if (!api?.publishMcpState) {
    return;
  }

  api.publishMcpState(buildMcpStatePayload());
}

function cloneReasoningOverlayStateForCapture(overlay) {
  return {
    ...createEmptyReasoningOverlay(),
    ...(overlay || {}),
  };
}

function cloneSectionStateForCapture(section) {
  return {
    enabled: Boolean(section?.enabled),
    axis: section?.axis || "x",
    offset: Number.isFinite(Number(section?.offset)) ? Number(section.offset) : 0,
  };
}

function buildBoundsFromPartIds(partIds = []) {
  if (!state.activeProject) {
    return null;
  }

  const boundsList = Array.from(new Set(partIds))
    .map((partId) => state.activeProject.nodeMap.get(partId)?.bbox)
    .filter(Boolean);

  if (!boundsList.length) {
    return state.activeProject.assembly?.bounds || null;
  }

  const first = boundsList[0];
  const min = { ...first.min };
  const max = { ...first.max };

  boundsList.slice(1).forEach((bbox) => {
    min.x = Math.min(min.x, bbox.min.x);
    min.y = Math.min(min.y, bbox.min.y);
    min.z = Math.min(min.z, bbox.min.z);
    max.x = Math.max(max.x, bbox.max.x);
    max.y = Math.max(max.y, bbox.max.y);
    max.z = Math.max(max.z, bbox.max.z);
  });

  return {
    min,
    max,
    center: {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    },
    size: {
      x: max.x - min.x,
      y: max.y - min.y,
      z: max.z - min.z,
    },
  };
}

function createViewerCaptureSnapshot() {
  return {
    camera: state.viewer?.snapshot?.() || null,
    hiddenNodeIds: new Set(state.viewer?.state?.hiddenNodeIds || state.workbench?.hiddenNodeIds || []),
    isolatedNodeIds:
      state.viewer?.state?.isolatedNodeIds == null
        ? null
        : new Set(state.viewer.state.isolatedNodeIds),
    nodeOpacityMap: { ...(state.viewer?.state?.nodeOpacityMap || state.workbench?.nodeOpacityMap || {}) },
    nodeTranslationMap: { ...(state.viewer?.state?.nodeTranslationMap || state.workbench?.nodeTranslationMap || {}) },
    faceMapTargetPartIds: [...(state.viewer?.state?.faceMapTargetPartIds || state.workbench?.faceMapTargetPartIds || [])],
    displayMode: state.viewer?.state?.displayMode || state.workbench?.displayMode || "beauty",
    section: cloneSectionStateForCapture(state.viewer?.state?.section || state.workbench?.section),
    reasoningOverlay: cloneReasoningOverlayStateForCapture(state.viewer?.state?.reasoningOverlay),
    selection: state.workbench?.selection || null,
  };
}

function applyViewerCaptureState(snapshot, overrides = {}) {
  if (!state.viewer || !state.workbench) {
    return;
  }

  state.viewer.updateState({
    selectionMode: state.workbench.selectionMode,
    hiddenNodeIds: overrides.hiddenNodeIds === undefined ? snapshot.hiddenNodeIds : overrides.hiddenNodeIds,
    isolatedNodeIds: overrides.isolatedNodeIds === undefined ? snapshot.isolatedNodeIds : overrides.isolatedNodeIds,
    nodeOpacityMap: overrides.nodeOpacityMap === undefined ? snapshot.nodeOpacityMap : overrides.nodeOpacityMap,
    nodeTranslationMap:
      overrides.nodeTranslationMap === undefined ? snapshot.nodeTranslationMap : overrides.nodeTranslationMap,
    faceMapTargetPartIds:
      overrides.faceMapTargetPartIds === undefined ? snapshot.faceMapTargetPartIds : overrides.faceMapTargetPartIds,
    displayMode: overrides.displayMode === undefined ? snapshot.displayMode : overrides.displayMode,
    section: overrides.section === undefined ? snapshot.section : overrides.section,
    reasoningOverlay: overrides.reasoningOverlay === undefined ? snapshot.reasoningOverlay : overrides.reasoningOverlay,
  });
  state.viewer.setSelection(snapshot.selection || null);
}

function captureViewerArtifact(mode, options = {}) {
  const artifact = state.viewer.capture(mode, {
    width: options.width,
    height: options.height,
    fit: false,
    preset: options.preset,
  });

  return {
    name: options.name || options.preset || mode,
    label: options.label || null,
    preset: options.preset || null,
    axis: options.axis || null,
    offset: options.offset ?? null,
    dataUrl: artifact.dataUrl,
    mimeType: artifact.mimeType,
    width: artifact.width,
    height: artifact.height,
    colorMap: artifact.colorMap || [],
  };
}

async function captureMcpEvidenceBundle(payload) {
  if (!state.viewer || !state.activeProject || !state.workbench) {
    throw new Error("当前没有活动工作台，无法生成证据包。");
  }

  const target = payload?.target || {};
  const width = Math.max(64, Number(payload?.width) || 960);
  const height = Math.max(64, Number(payload?.height) || 720);
  const focusPartIds = Array.from(new Set(target.partIds || target.overlay?.focusPartIds || []));
  const overlay = payload?.includeOverlay === false
    ? createEmptyReasoningOverlay()
    : {
        ...createEmptyReasoningOverlay(),
        ...(target.overlay || {}),
      };
  const transparentContext = payload?.includeTransparentContext === true;
  const focusBounds = buildBoundsFromPartIds(focusPartIds);
  const snapshot = createViewerCaptureSnapshot();
  const images = {
    globalBeautyViews: [],
    globalPartMaskViews: [],
    globalPartMaskRawViews: [],
    localOverlayViews: [],
    localFaceMaskViews: [],
    localFaceMaskRawViews: [],
    sectionViews: [],
  };
  const colorMaps = {
    partMask: [],
    partMaskRaw: [],
    partMaskPalette: [],
    faceMask: [],
    faceMaskRaw: [],
    faceMaskPalette: [],
  };

  const focusIsolation = focusPartIds.length && !transparentContext ? new Set(focusPartIds) : null;
  const globalSection = {
    ...snapshot.section,
    enabled: false,
  };

  try {
    const globalPresets = ["front", "top", "iso"];

    if (payload?.includeGlobalViews !== false) {
      applyViewerCaptureState(snapshot, {
        hiddenNodeIds: new Set(),
        isolatedNodeIds: null,
        displayMode: "beauty",
        section: globalSection,
        reasoningOverlay: createEmptyReasoningOverlay(),
      });

      globalPresets.forEach((preset) => {
        images.globalBeautyViews.push(
          captureViewerArtifact("beauty", {
            name: `global_${preset}`,
            preset,
            width,
            height,
            label: `global-${preset}`,
          }),
        );
      });
    }

    if (payload?.includePartMask !== false) {
      applyViewerCaptureState(snapshot, {
        hiddenNodeIds: new Set(),
        isolatedNodeIds: null,
        displayMode: "beauty",
        section: globalSection,
        reasoningOverlay: createEmptyReasoningOverlay(),
      });

      globalPresets.forEach((preset) => {
        const paletteArtifact = captureViewerArtifact("id-mask-palette", {
          name: `part_mask_${preset}`,
          preset,
          width,
          height,
          label: `part-mask-${preset}`,
        });
        const rawArtifact = captureViewerArtifact("id-mask", {
          name: `part_mask_raw_${preset}`,
          preset,
          width,
          height,
          label: `part-mask-raw-${preset}`,
        });
        images.globalPartMaskViews.push(paletteArtifact);
        images.globalPartMaskRawViews.push(rawArtifact);
        if (!colorMaps.partMaskPalette.length && paletteArtifact.colorMap?.length) {
          colorMaps.partMaskPalette = paletteArtifact.colorMap;
          colorMaps.partMask = paletteArtifact.colorMap;
        }
        if (!colorMaps.partMaskRaw.length && rawArtifact.colorMap?.length) {
          colorMaps.partMaskRaw = rawArtifact.colorMap;
        }
      });
    }

    if (payload?.includeLocalViews !== false) {
      applyViewerCaptureState(snapshot, {
        hiddenNodeIds: new Set(),
        isolatedNodeIds: focusIsolation,
        displayMode: "beauty",
        section: globalSection,
        reasoningOverlay: overlay,
      });
      if (focusBounds) {
        state.viewer.setCameraToBounds(focusBounds);
      } else {
        state.viewer.fit();
      }

      if (payload?.includeOverlay !== false) {
        images.localOverlayViews.push(
          captureViewerArtifact("beauty", {
            name: "local_overlay_focus",
            width,
            height,
            label: "local-overlay-focus",
          }),
        );
      }

      if (payload?.includeFaceMask !== false) {
        const paletteArtifact = captureViewerArtifact("face-mask-palette", {
          name: "local_face_mask_focus",
          width,
          height,
          label: "local-face-mask-focus",
        });
        const rawArtifact = captureViewerArtifact("face-mask", {
          name: "local_face_mask_raw_focus",
          width,
          height,
          label: "local-face-mask-raw-focus",
        });
        images.localFaceMaskViews.push(paletteArtifact);
        images.localFaceMaskRawViews.push(rawArtifact);
        if (paletteArtifact.colorMap?.length) {
          colorMaps.faceMaskPalette = paletteArtifact.colorMap;
          colorMaps.faceMask = paletteArtifact.colorMap;
        }
        if (rawArtifact.colorMap?.length) {
          colorMaps.faceMaskRaw = rawArtifact.colorMap;
        }
      }
    }

    if (payload?.includeSectionViews === true) {
      ["x", "y", "z"].forEach((axis) => {
        const offset = focusBounds?.center?.[axis] ?? state.activeProject.assembly?.bounds?.center?.[axis] ?? 0;
        applyViewerCaptureState(snapshot, {
          hiddenNodeIds: new Set(),
          isolatedNodeIds: focusIsolation,
          displayMode: "beauty",
          section: {
            enabled: true,
            axis,
            offset,
          },
          reasoningOverlay: overlay,
        });
        if (focusBounds) {
          state.viewer.setCameraToBounds(focusBounds);
        } else {
          state.viewer.fit();
        }
        images.sectionViews.push(
          captureViewerArtifact("beauty", {
            name: `section_${axis}_mid`,
            width,
            height,
            axis,
            offset,
            label: `section-${axis}-mid`,
          }),
        );
      });
    }
  } finally {
    applyViewerCaptureState(snapshot, snapshot);
    if (snapshot.camera) {
      state.viewer.restore(snapshot.camera);
    }
  }

  return {
    target: {
      ...target,
      partIds: focusPartIds,
    },
    images,
    colorMaps,
    metadata: {
      width,
      height,
      transparentContext,
      focusPartIds,
      focusFaceIds: target.focusFaceIds || [],
      sectionAxes: images.sectionViews.map((item) => item.axis).filter(Boolean),
    },
  };
}

async function ensureWorkbenchForMcp(projectId) {
  let resolvedProjectId = projectId || state.activeProject?.manifest?.projectId || state.route.projectId || null;

  if (!resolvedProjectId) {
    state.projects = await api.listProjects();
    resolvedProjectId = state.projects.find((project) => project.status === "ready")?.projectId || null;
  }

  if (!resolvedProjectId) {
    throw new Error("当前没有可用于 MCP 的 ready 项目。");
  }

  const needsLoad =
    state.route.page !== "workbench" ||
    state.route.projectId !== resolvedProjectId ||
    state.activeProject?.manifest?.projectId !== resolvedProjectId ||
    !state.workbench;

  if (needsLoad) {
    state.route = { page: "workbench", projectId: resolvedProjectId };
    await loadProject(resolvedProjectId);
  } else if (!state.viewer) {
    render();
  }

  if (!state.viewer) {
    render();
  }

  await new Promise((resolve) => {
    window.setTimeout(resolve, needsLoad ? 200 : 50);
  });

  if (!state.viewer || !state.activeProject || !state.workbench) {
    throw new Error("MCP 工作台上下文尚未准备完成。");
  }

  return resolvedProjectId;
}

async function executeMcpCommand(payload) {
  const action = payload.action;
  if (action === "capture-evidence-bundle") {
    await ensureWorkbenchForMcp(payload?.projectId);
    return captureMcpEvidenceBundle(payload || {});
  }

  if (state.route.page !== "workbench" || !state.activeProject || !state.workbench) {
    throw new Error("当前没有活动工作台，无法执行 MCP 交互命令。");
  }

  if (payload.projectId && payload.projectId !== state.activeProject.manifest.projectId) {
    throw new Error("当前工作台中的项目与目标 projectId 不一致。");
  }

  switch (action) {
    case "isolate-parts": {
      const rawPartIds = Array.isArray(payload.partIds) ? payload.partIds : [];
      const validPartIds = rawPartIds.filter((partId) => state.activeProject.nodeMap.get(partId)?.kind === "part");
      if (!validPartIds.length) {
        throw new Error("没有可隔离的零件 ID。");
      }
      state.workbench.isolatedNodeIds = new Set(validPartIds);
      state.workbench.activePanel = "display";
      break;
    }
    case "clear-isolation": {
      state.workbench.isolatedNodeIds = null;
      break;
    }
    case "set-section-plane": {
      const axis = ["x", "y", "z"].includes(payload.axis) ? payload.axis : null;
      if (!axis) {
        throw new Error("剖切轴必须是 x / y / z。");
      }
      const offset = Number(payload.offset);
      if (!Number.isFinite(offset)) {
        throw new Error("剖切 offset 无效。");
      }
      state.workbench.section.axis = axis;
      state.workbench.section.offset = offset;
      state.workbench.section.enabled = payload.enabled !== false;
      state.workbench.activePanel = "section";
      break;
    }
    case "clear-section-plane": {
      state.workbench.section.enabled = false;
      break;
    }
    case "agent-focus-parts": {
      const validPartIds = (Array.isArray(payload.partIds) ? payload.partIds : []).filter(
        (partId) => state.activeProject.nodeMap.get(partId)?.kind === "part",
      );
      if (!validPartIds.length) {
        throw new Error("没有可聚焦的零件 ID。");
      }
      state.workbench.hiddenNodeIds = new Set();
      state.workbench.isolatedNodeIds = new Set(validPartIds);
      break;
    }
    case "agent-hide-parts": {
      const validPartIds = (Array.isArray(payload.partIds) ? payload.partIds : []).filter(
        (partId) => state.activeProject.nodeMap.get(partId)?.kind === "part",
      );
      if (!validPartIds.length) {
        throw new Error("没有可隐藏的零件 ID。");
      }
      const nextHidden = new Set(state.workbench.hiddenNodeIds);
      validPartIds.forEach((partId) => nextHidden.add(partId));
      state.workbench.hiddenNodeIds = nextHidden;
      state.workbench.isolatedNodeIds = null;
      break;
    }
    case "agent-set-opacity": {
      const validPartIds = (Array.isArray(payload.partIds) ? payload.partIds : []).filter(
        (partId) => state.activeProject.nodeMap.get(partId)?.kind === "part",
      );
      if (!validPartIds.length) {
        throw new Error("没有可设置透明度的零件 ID。");
      }
      const opacity = Math.max(0.05, Math.min(1, Number(payload.opacity) || 1));
      const nextOpacityMap = { ...(state.workbench.nodeOpacityMap || {}) };
      validPartIds.forEach((partId) => {
        if (opacity >= 0.999) {
          delete nextOpacityMap[partId];
        } else {
          nextOpacityMap[partId] = opacity;
        }
      });
      state.workbench.nodeOpacityMap = nextOpacityMap;
      break;
    }
    case "agent-set-face-map": {
      const validPartIds = (Array.isArray(payload.partIds) ? payload.partIds : []).filter(
        (partId) => state.activeProject.nodeMap.get(partId)?.kind === "part",
      );
      if (!validPartIds.length) {
        throw new Error("没有可显示面映射的零件 ID。");
      }
      state.workbench.displayMode = "face-map";
      state.workbench.faceMapTargetPartIds = validPartIds;
      break;
    }
    case "agent-disable-face-map": {
      state.workbench.displayMode = "beauty";
      state.workbench.faceMapTargetPartIds = [];
      break;
    }
    case "agent-reset-display": {
      state.workbench.hiddenNodeIds = new Set();
      state.workbench.isolatedNodeIds = null;
      state.workbench.displayMode = "beauty";
      state.workbench.faceMapTargetPartIds = [];
      break;
    }
    case "agent-translate-parts": {
      const validPartIds = (Array.isArray(payload.partIds) ? payload.partIds : []).filter(
        (partId) => state.activeProject.nodeMap.get(partId)?.kind === "part",
      );
      if (!validPartIds.length) {
        throw new Error("没有可移动的零件 ID。");
      }
      const direction = payload.direction || {};
      const dx = Number(direction.x) || 0;
      const dy = Number(direction.y) || 0;
      const dz = Number(direction.z) || 0;
      const distance = Math.abs(Number(payload.distance) || 0);
      if (!distance) {
        throw new Error("移动距离无效。");
      }
      const nextTranslationMap = { ...(state.workbench.nodeTranslationMap || {}) };
      validPartIds.forEach((partId) => {
        const current = nextTranslationMap[partId] || { x: 0, y: 0, z: 0 };
        nextTranslationMap[partId] = {
          x: (current.x || 0) + dx * distance,
          y: (current.y || 0) + dy * distance,
          z: (current.z || 0) + dz * distance,
        };
      });
      state.workbench.nodeTranslationMap = nextTranslationMap;
      break;
    }
    case "agent-reset-translation-parts": {
      const validPartIds = (Array.isArray(payload.partIds) ? payload.partIds : []).filter(
        (partId) => state.activeProject.nodeMap.get(partId)?.kind === "part",
      );
      if (!validPartIds.length) {
        state.workbench.nodeTranslationMap = {};
      } else {
        const nextTranslationMap = { ...(state.workbench.nodeTranslationMap || {}) };
        validPartIds.forEach((partId) => {
          delete nextTranslationMap[partId];
        });
        state.workbench.nodeTranslationMap = nextTranslationMap;
      }
      break;
    }
    case "capture-step-preview": {
      if (!payload.step || !state.viewer?.captureStepPreview) {
        throw new Error("当前 viewer 不支持步骤预览截图。");
      }
      return state.viewer.captureStepPreview(payload.step, {
        width: payload.width,
        height: payload.height,
        fit: payload.fit,
      });
    }
    default:
      throw new Error(`未知 MCP 命令：${action}`);
  }

  render();
  return buildMcpStatePayload();
}
function parseRoute() {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("/workbench/")) {
    const projectId = hash.split("/")[2];
    return { page: "workbench", projectId };
  }

  return { page: "home", projectId: null };
}

function setRoute(nextRoute) {
  if (nextRoute.page === "workbench" && nextRoute.projectId) {
    window.location.hash = `#/workbench/${nextRoute.projectId}`;
    return;
  }

  window.location.hash = "#/";
}

async function handleHashChange() {
  state.route = parseRoute();
  await syncRoute();
}
async function syncRoute() {
  if (state.route.page === "workbench" && state.route.projectId) {
    await loadProject(state.route.projectId);
  } else {
    state.loadingProjectId = null;
    state.activeProject = null;
    state.workbench = null;
    destroyViewer();
    render();
  }
}

async function loadProject(projectId) {
  state.loadingProjectId = projectId;
  render();

  const details = await api.getProjectDetails(projectId);
  if (!details?.manifest) {
    pushToast("项目不存在或已被删除。", "warning");
    setRoute({ page: "home" });
    return;
  }

  if (details.manifest.status !== "ready") {
    pushToast("该项目尚未完成解析，暂时无法进入工作台。", "warning");
    setRoute({ page: "home" });
    return;
  }

  state.activeProject = hydrateProject(details);
  state.workbench = createWorkbenchState(state.activeProject, state.workbench);
  state.loadingProjectId = null;
  render();
}
function hydrateProject(details) {
  const assembly = details.assembly || { nodes: [], meshes: [], rootId: null, bounds: { size: { x: 1, y: 1, z: 1 } } };
  const nodeMap = new Map(assembly.nodes.map((node) => [node.id, node]));
  const meshMap = new Map((assembly.meshes || []).map((mesh) => [mesh.id, mesh]));
  const faceMap = new Map();
  (assembly.meshes || []).forEach((mesh) => {
    (mesh.brepFaces || []).forEach((face) => {
      faceMap.set(face.id, face);
    });
  });
  return {
    ...details,
    assembly,
    nodeMap,
    meshMap,
    faceMap,
    partNodes: assembly.nodes.filter((node) => node.kind === "part"),
    assemblyNodes: assembly.nodes.filter((node) => node.kind === "assembly"),
    rootNode: nodeMap.get(assembly.rootId) || null,
  };
}

function createWorkbenchState(project, previousState) {
  const previousForSameProject =
    previousState && previousState.projectId === project.manifest.projectId ? previousState : null;
  const topLevelAssemblies = project.assemblyNodes
    .filter((node) => node.depth <= 1)
    .map((node) => node.id);
  const defaultSelection = previousForSameProject?.selection
    ? previousForSameProject.selection
    : project.assembly.defaultSelectionId
      ? buildSelectionFromNode(project, project.assembly.defaultSelectionId)
      : null;
  const axisBounds = project.assembly.bounds?.max?.x || 100;

  return {
    projectId: project.manifest.projectId,
    workspaceMode: previousForSameProject?.workspaceMode || "model",
    activePanel: previousForSameProject?.activePanel || "assembly",
    reasoningPanel:
      previousForSameProject?.reasoningPanel && previousForSameProject.reasoningPanel !== "agent"
        ? previousForSameProject.reasoningPanel
        : "summary",
    selectionMode: previousForSameProject?.selectionMode || "part",
    selection: defaultSelection,
    expandedNodeIds: previousForSameProject?.expandedNodeIds || new Set(topLevelAssemblies),
    treeSearch: previousForSameProject?.treeSearch || "",
    hiddenNodeIds: previousForSameProject?.hiddenNodeIds || new Set(),
    isolatedNodeIds: previousForSameProject?.isolatedNodeIds || null,
    nodeOpacityMap: previousForSameProject?.nodeOpacityMap ? { ...previousForSameProject.nodeOpacityMap } : {},
    nodeTranslationMap: previousForSameProject?.nodeTranslationMap ? { ...previousForSameProject.nodeTranslationMap } : {},
    faceMapTargetPartIds: previousForSameProject?.faceMapTargetPartIds || [],
    displayMode: previousForSameProject?.displayMode || "beauty",
    section: previousForSameProject?.section || {
      enabled: false,
      axis: "x",
      offset: Math.round(axisBounds),
    },
    measure: previousForSameProject?.measure || {
      enabled: false,
      mode: "distance",
      picks: [],
      result: null,
      history: [],
    },
    reasoning: createEmptyReasoningState(previousForSameProject?.reasoning),
    viewerHint: previousForSameProject?.viewerHint || "拖拽旋转，Shift + 拖拽平移，滚轮缩放",
  };
}

function getActivePanelMeta() {
  if (!state.workbench) {
    return null;
  }

  return state.workbench.workspaceMode === "reasoning"
    ? REASONING_PANEL_META[state.workbench.reasoningPanel]
    : PANEL_META[state.workbench.activePanel];
}

function getReasoningSelectionPayload() {
  if (!state.activeProject || !state.workbench) {
    return {};
  }

  const selection = state.workbench.reasoning.selection;
  return {
    projectId: state.activeProject.manifest.projectId,
    basePartId: selection.basePartId || undefined,
    assemblingPartId: selection.assemblingPartId || undefined,
    sequenceId: selection.sequenceId || undefined,
    stepIndex: selection.stepIndex || undefined,
  };
}

function getReasoningStatusLabel(status) {
  return {
    idle: "未分析",
    loading: "分析中",
    ready: "已更新",
    error: "出错",
  }[status] || "未知";
}

function getReasoningSequence(sequenceId = state.workbench?.reasoning.selection.sequenceId) {
  const sequences = state.workbench?.reasoning?.data?.plan?.candidateSequences || [];
  return sequences.find((item) => item.sequenceId === sequenceId) || sequences[0] || null;
}

function getPartDisplayName(partId) {
  if (!partId || !state.activeProject) {
    return "-";
  }
  return state.activeProject.nodeMap.get(partId)?.name || partId;
}

function getFaceColorMapEntry(faceId) {
  if (!faceId) {
    return null;
  }

  const evidenceMap =
    state.workbench?.reasoning?.data?.stepVisualEvidence?.faceColorMap ||
    state.viewer?.getColorMap?.("face-mask") ||
    [];
  return evidenceMap.find((entry) => entry.faceId === faceId) || null;
}

function getAgentStatusLabel(status) {
  return {
    idle: "未运行",
    running: "分析中",
    ready: "已完成",
    error: "失败",
  }[status] || "未知";
}

function getDisplayModeLabel(displayMode) {
  return displayMode === "face-map" ? "零件面映射" : "普通显示";
}

function getFaceMapTargetPartIds() {
  if (!state.workbench) {
    return [];
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  return resolveAgentTargetPartIds(agent.partQuery).partIds;
}

function haveSameItems(left = [], right = []) {
  if (left.length !== right.length) {
    return false;
  }
  const leftSet = new Set(left);
  return right.every((item) => leftSet.has(item));
}

function uniqueNonEmpty(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getCurrentAgentTimelineStep() {
  if (!state.workbench) {
    return null;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  return agent.selectedTimelineIndex >= 0 ? agent.timeline?.[agent.selectedTimelineIndex] || null : null;
}

function getDefaultAgentTargetPartIds() {
  if (!state.workbench) {
    return [];
  }

  const reasoning = state.workbench.reasoning;
  const currentAgentStep = getCurrentAgentTimelineStep();
  const selectedNodePartIds = state.workbench.selection?.nodeId
    ? getPartIdsForNode(state.workbench.selection.nodeId)
    : [];

  return uniqueNonEmpty([
    ...(currentAgentStep?.focusPartIds || []),
    currentAgentStep?.basePartId,
    currentAgentStep?.assemblingPartId,
    reasoning.selection.basePartId,
    reasoning.selection.assemblingPartId,
    ...selectedNodePartIds,
  ]);
}

function parseAgentPartQuery(query) {
  return String(query || "")
    .split(/[\n,;，；]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAgentTargetPartIds(query = "") {
  if (!state.activeProject) {
    return { partIds: [], unresolvedTokens: [] };
  }

  const tokens = parseAgentPartQuery(query);
  if (!tokens.length) {
    return { partIds: getDefaultAgentTargetPartIds(), unresolvedTokens: [] };
  }

  const partNodes = state.activeProject.partNodes || [];
  const exactNameMap = new Map();
  partNodes.forEach((node) => {
    const key = String(node.name || "").trim().toLowerCase();
    if (!key) {
      return;
    }
    if (!exactNameMap.has(key)) {
      exactNameMap.set(key, []);
    }
    exactNameMap.get(key).push(node.id);
  });

  const resolved = [];
  const unresolvedTokens = [];

  tokens.forEach((token) => {
    if (state.activeProject.nodeMap.get(token)?.kind === "part") {
      resolved.push(token);
      return;
    }

    const lowerToken = token.toLowerCase();
    const exactMatches = exactNameMap.get(lowerToken) || [];
    if (exactMatches.length === 1) {
      resolved.push(exactMatches[0]);
      return;
    }

    const fuzzyMatches = partNodes
      .filter((node) => String(node.name || "").toLowerCase().includes(lowerToken))
      .map((node) => node.id);
    if (fuzzyMatches.length === 1) {
      resolved.push(fuzzyMatches[0]);
      return;
    }

    unresolvedTokens.push(token);
  });

  return {
    partIds: uniqueNonEmpty(resolved),
    unresolvedTokens,
  };
}

function applyAgentPartIsolation() {
  if (!state.workbench) {
    return;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  const { partIds, unresolvedTokens } = resolveAgentTargetPartIds(agent.partQuery);

  if (unresolvedTokens.length) {
    pushToast(`未识别零件：${unresolvedTokens.join(" / ")}`, "warning");
  }
  if (!partIds.length) {
    pushToast("没有可单独显示的零件，请输入零件 ID/名称或先选中流程节点。", "warning");
    return;
  }

  state.workbench.isolatedNodeIds = new Set(partIds);
  state.workbench.hiddenNodeIds = new Set();
  state.workbench.reasoningPanel = "agent";
  syncViewerState();
  render();
  pushToast(`已聚焦 ${partIds.length} 个零件。`, "success");
}

function clearAgentPartIsolation() {
  if (!state.workbench) {
    return;
  }

  state.workbench.isolatedNodeIds = null;
  syncViewerState();
  render();
  pushToast("已恢复全部零件显示。", "info");
}

function hideAgentTargetParts() {
  if (!state.workbench) {
    return;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  const { partIds, unresolvedTokens } = resolveAgentTargetPartIds(agent.partQuery);

  if (unresolvedTokens.length) {
    pushToast(`未识别零件：${unresolvedTokens.join(" / ")}`, "warning");
  }
  if (!partIds.length) {
    pushToast("没有可隐藏的零件，请输入零件 ID/名称或先选中流程节点。", "warning");
    return;
  }

  const nextHidden = new Set(state.workbench.hiddenNodeIds || []);
  partIds.forEach((partId) => nextHidden.add(partId));
  state.workbench.hiddenNodeIds = nextHidden;
  state.workbench.isolatedNodeIds = null;

  if (state.workbench.selection && partIds.includes(state.workbench.selection.nodeId)) {
    state.workbench.selection = null;
  }

  syncViewerState();
  render();
  pushToast(`已隐藏 ${partIds.length} 个零件。`, "success");
}

function resetDisplayVisibilityState() {
  if (!state.workbench) {
    return;
  }

  state.workbench.hiddenNodeIds = new Set();
  state.workbench.isolatedNodeIds = null;
  syncViewerState();
  render();
  pushToast("已恢复默认显示范围。", "info");
}

function applyAgentPartOpacity() {
  if (!state.workbench) {
    return;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  const { partIds, unresolvedTokens } = resolveAgentTargetPartIds(agent.partQuery);

  if (unresolvedTokens.length) {
    pushToast(`未识别零件：${unresolvedTokens.join(" / ")}`, "warning");
  }
  if (!partIds.length) {
    pushToast("没有可调整透明度的零件，请输入零件 ID/名称或先选中流程节点。", "warning");
    return;
  }

  const opacity = Math.max(0.05, Math.min(1, Number(agent.opacityValue) || 1));
  const nextMap = { ...(state.workbench.nodeOpacityMap || {}) };
  partIds.forEach((partId) => {
    if (opacity >= 0.999) {
      delete nextMap[partId];
    } else {
      nextMap[partId] = opacity;
    }
  });
  state.workbench.nodeOpacityMap = nextMap;
  syncViewerState();
  render();
  pushToast(
    opacity >= 0.999
      ? `已将 ${partIds.length} 个零件恢复为默认不透明度。`
      : `已将 ${partIds.length} 个零件的不透明度设置为 ${Math.round(opacity * 100)}%。`,
    "success",
  );
}

function resetAgentPartOpacity() {
  if (!state.workbench) {
    return;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  const { partIds } = resolveAgentTargetPartIds(agent.partQuery);
  if (!partIds.length) {
    state.workbench.nodeOpacityMap = {};
    syncViewerState();
    render();
    pushToast("已恢复所有零件的默认不透明度。", "info");
    return;
  }

  const nextMap = { ...(state.workbench.nodeOpacityMap || {}) };
  partIds.forEach((partId) => {
    delete nextMap[partId];
  });
  state.workbench.nodeOpacityMap = nextMap;
  syncViewerState();
  render();
  pushToast(`已恢复 ${partIds.length} 个零件的默认不透明度。`, "info");
}

function setWorkbenchDisplayMode(displayMode) {
  if (!state.workbench) {
    return;
  }

  const nextMode = displayMode === "face-map" ? "face-map" : "beauty";
  state.workbench.displayMode = nextMode;
  state.workbench.reasoning.data.agentAnalysis.faceMapEnabled = nextMode === "face-map";
  state.workbench.faceMapTargetPartIds = nextMode === "face-map" ? getFaceMapTargetPartIds() : [];
  syncViewerState();
  render();
}

function enableAgentFaceMap() {
  const targetPartIds = getFaceMapTargetPartIds();
  if (!targetPartIds.length) {
    pushToast("没有可做面映射的目标零件，请先输入零件或选中当前焦点。", "warning");
    return;
  }
  setWorkbenchDisplayMode("face-map");
  pushToast(`已显示 ${targetPartIds.length} 个目标零件的高饱和面映射。`, "success");
}

function disableAgentFaceMap() {
  setWorkbenchDisplayMode("beauty");
  pushToast("已恢复普通模型显示。", "info");
}

function toggleFaceMapDisplay() {
  if (!state.workbench) {
    return;
  }

  const nextTargetPartIds = getFaceMapTargetPartIds();
  if (
    state.workbench.displayMode === "face-map" &&
    nextTargetPartIds.length &&
    !haveSameItems(nextTargetPartIds, state.workbench.faceMapTargetPartIds || [])
  ) {
    state.workbench.faceMapTargetPartIds = nextTargetPartIds;
    syncViewerState();
    render();
    pushToast(`已更新面映射目标，共 ${nextTargetPartIds.length} 个零件。`, "success");
    return;
  }

  if (state.workbench.displayMode === "face-map") {
    disableAgentFaceMap();
    return;
  }

  enableAgentFaceMap();
}

function getAgentMoveVector() {
  if (!state.workbench) {
    return null;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  const x = Number(agent.moveDirectionX) || 0;
  const y = Number(agent.moveDirectionY) || 0;
  const z = Number(agent.moveDirectionZ) || 0;
  const length = Math.sqrt(x ** 2 + y ** 2 + z ** 2);
  if (!length) {
    return null;
  }

  return {
    x: x / length,
    y: y / length,
    z: z / length,
  };
}

function applyAgentPartTranslation() {
  if (!state.workbench) {
    return;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  const { partIds, unresolvedTokens } = resolveAgentTargetPartIds(agent.partQuery);
  const direction = getAgentMoveVector();
  const distance = Number(agent.moveDistance) || 0;

  if (unresolvedTokens.length) {
    pushToast(`未识别零件：${unresolvedTokens.join(" / ")}`, "warning");
  }
  if (!partIds.length) {
    pushToast("没有可移动的零件，请输入零件 ID/名称或先选中流程节点。", "warning");
    return;
  }
  if (!direction) {
    pushToast("移动方向不能为 0 / 0 / 0。", "warning");
    return;
  }
  if (!Number.isFinite(distance) || !distance) {
    pushToast("请输入有效的移动距离。", "warning");
    return;
  }

  const delta = {
    x: direction.x * distance,
    y: direction.y * distance,
    z: direction.z * distance,
  };
  const nextMap = { ...(state.workbench.nodeTranslationMap || {}) };
  partIds.forEach((partId) => {
    const current = nextMap[partId] || { x: 0, y: 0, z: 0 };
    nextMap[partId] = {
      x: (current.x || 0) + delta.x,
      y: (current.y || 0) + delta.y,
      z: (current.z || 0) + delta.z,
    };
  });

  state.workbench.nodeTranslationMap = nextMap;
  syncViewerState();
  render();
  pushToast(`已沿指定方向移动 ${partIds.length} 个零件 ${formatNumber(distance)} mm。`, "success");
}

function resetAgentPartTranslation() {
  if (!state.workbench) {
    return;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  const { partIds } = resolveAgentTargetPartIds(agent.partQuery);

  if (!partIds.length) {
    state.workbench.nodeTranslationMap = {};
    syncViewerState();
    render();
    pushToast("已恢复所有零件的默认位置。", "info");
    return;
  }

  const nextMap = { ...(state.workbench.nodeTranslationMap || {}) };
  partIds.forEach((partId) => {
    delete nextMap[partId];
  });
  state.workbench.nodeTranslationMap = nextMap;
  syncViewerState();
  render();
  pushToast(`已恢复 ${partIds.length} 个零件的默认位置。`, "info");
}

function normalizeAgentInsertionAxis(axis) {
  if (!axis || typeof axis !== "object") {
    return null;
  }

  const origin = axis.origin && typeof axis.origin === "object"
    ? {
        x: Number.isFinite(Number(axis.origin.x)) ? Number(axis.origin.x) : 0,
        y: Number.isFinite(Number(axis.origin.y)) ? Number(axis.origin.y) : 0,
        z: Number.isFinite(Number(axis.origin.z)) ? Number(axis.origin.z) : 0,
      }
    : null;

  const direction = axis.direction && typeof axis.direction === "object"
    ? {
        x: Number.isFinite(Number(axis.direction.x)) ? Number(axis.direction.x) : 0,
        y: Number.isFinite(Number(axis.direction.y)) ? Number(axis.direction.y) : 0,
        z: Number.isFinite(Number(axis.direction.z)) ? Number(axis.direction.z) : 1,
      }
    : { x: 0, y: 0, z: 1 };

  const length = Number.isFinite(Number(axis.length)) ? Math.max(8, Number(axis.length)) : 16;
  return {
    origin,
    direction,
    length,
  };
}

function normalizeAgentFocus(focus = {}) {
  const focusPartIds = Array.from(
    new Set([
      ...(Array.isArray(focus.focusPartIds) ? focus.focusPartIds : []),
      focus.basePartId,
      focus.assemblingPartId,
    ].filter(Boolean)),
  );

  return {
    basePartId: focus.basePartId || focusPartIds[0] || null,
    assemblingPartId: focus.assemblingPartId || focusPartIds[1] || null,
    focusPartIds,
    baseFaceIds: Array.from(new Set((Array.isArray(focus.baseFaceIds) ? focus.baseFaceIds : []).filter(Boolean))),
    assemblingFaceIds: Array.from(
      new Set((Array.isArray(focus.assemblingFaceIds) ? focus.assemblingFaceIds : []).filter(Boolean)),
    ),
    focusFaceIds: Array.from(new Set((Array.isArray(focus.focusFaceIds) ? focus.focusFaceIds : []).filter(Boolean))),
    insertionAxis: normalizeAgentInsertionAxis(focus.insertionAxis),
  };
}

function buildOverlayFromAgentFocus(focus = {}) {
  const normalized = normalizeAgentFocus(focus);
  const inferredBaseFaces = normalized.baseFaceIds.length
    ? normalized.baseFaceIds
    : normalized.focusFaceIds.slice(0, 1);
  const inferredAssemblingFaces = normalized.assemblingFaceIds.length
    ? normalized.assemblingFaceIds
    : normalized.focusFaceIds.slice(1, 2);

  return {
    ...createEmptyReasoningOverlay(),
    focusPartIds: normalized.focusPartIds,
    basePartId: normalized.basePartId,
    assemblingPartId: normalized.assemblingPartId,
    baseFaceIds: inferredBaseFaces,
    assemblingFaceIds: inferredAssemblingFaces,
    insertionAxis: normalized.insertionAxis,
    interferenceBoxes: [],
  };
}

function applyAgentTimelineFocus(index, options = {}) {
  if (!state.workbench) {
    return;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  const timeline = Array.isArray(agent.timeline) ? agent.timeline : [];
  if (!timeline.length) {
    return;
  }

  const nextIndex = Math.max(0, Math.min(timeline.length - 1, Number(index) || 0));
  agent.selectedTimelineIndex = nextIndex;
  if (!options.silent) {
    render();
  }
}

function inferAgentCandidateId(reasoning) {
  const basePartId = reasoning.selection.basePartId;
  const assemblingPartId = reasoning.selection.assemblingPartId;
  if (!basePartId || !assemblingPartId) {
    return null;
  }

  const match = (reasoning.data.matingCandidates || []).find((item) => {
    const forward = item.partAId === basePartId && item.partBId === assemblingPartId;
    const reverse = item.partAId === assemblingPartId && item.partBId === basePartId;
    return forward || reverse;
  });
  return match?.pairId ? `relation:${match.pairId}` : null;
}

function buildVlmAgentRequestPayload() {
  const reasoning = state.workbench.reasoning;
  const selection = reasoning.selection;
  const agent = reasoning.data.agentAnalysis;
  const focusPartIds = Array.from(
    new Set([
      selection.basePartId,
      selection.assemblingPartId,
      ...(reasoning.overlay?.focusPartIds || []),
    ].filter(Boolean)),
  );
  const focusFaceIds = Array.from(
    new Set([
      ...(reasoning.overlay?.baseFaceIds || []),
      ...(reasoning.overlay?.assemblingFaceIds || []),
      selection.highlightedBaseFaceId,
      selection.highlightedAssemblingFaceId,
    ].filter(Boolean)),
  );
  const stepVisual = reasoning.data.stepVisualEvidence;

  return {
    projectId: state.activeProject.manifest.projectId,
    instruction: agent.instruction || "",
    conversationHistory: agent.chatMessages || [],
    candidateId: inferAgentCandidateId(reasoning),
    focusPartIds,
    focusFaceIds,
    baseFaceIds: reasoning.overlay?.baseFaceIds || [],
    assemblingFaceIds: reasoning.overlay?.assemblingFaceIds || [],
    selection: {
      basePartId: selection.basePartId,
      assemblingPartId: selection.assemblingPartId,
      sequenceId: selection.sequenceId,
      stepIndex: selection.stepIndex,
      highlightedBaseFaceId: selection.highlightedBaseFaceId,
      highlightedAssemblingFaceId: selection.highlightedAssemblingFaceId,
    },
    localVisualEvidence: stepVisual
      ? {
          overlayDataUrl: stepVisual.overlayDataUrl || null,
          faceMaskDataUrl: stepVisual.faceMaskDataUrl || null,
        }
      : null,
    stepPreviewDataUrl: reasoning.data.stepPreview?.dataUrl || null,
    reasoningSnapshot: {
      summary: reasoning.data.summary || null,
      selectedPair: reasoning.data.selectedPair || null,
      relativeTransform: reasoning.data.relativeTransform || null,
      interference: reasoning.data.interference || null,
      plan: reasoning.data.plan || null,
      stepExplanation: reasoning.data.stepExplanation || null,
    },
  };
}

function appendAgentChatMessage(role, content) {
  if (!state.workbench) {
    return;
  }

  const agent = state.workbench.reasoning.data.agentAnalysis;
  agent.chatMessages = [
    ...(Array.isArray(agent.chatMessages) ? agent.chatMessages : []),
    {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      role: role === "assistant" ? "assistant" : "user",
      content: String(content || "").trim(),
      timestamp: new Date().toISOString(),
    },
  ].filter((item) => item.content).slice(-20);
}

async function runVlmAgentAnalysis(options = {}) {
  if (!state.workbench || !state.activeProject) {
    return;
  }

  const reasoning = state.workbench.reasoning;
  const agent = reasoning.data.agentAnalysis;
  state.workbench.workspaceMode = "model";
  state.workbench.activePanel = "agent";
  const userInstruction = String(options.instruction || agent.chatInput || agent.instruction || "").trim();

  if (options.fromChat) {
    if (!userInstruction) {
      pushToast("请先输入任务指令。", "warning");
      render({ preserveBoundInput: true });
      return;
    }
    agent.instruction = userInstruction;
    appendAgentChatMessage("user", userInstruction);
    agent.chatInput = "";
  } else if (userInstruction) {
    agent.instruction = userInstruction;
  }

  if (reasoning.status === "idle") {
    await refreshReasoningData();
  } else if (!reasoning.data.stepExplanation && reasoning.selection.sequenceId) {
    await loadReasoningStep({ silent: true });
  } else if (!reasoning.data.stepVisualEvidence && reasoning.data.stepExplanation) {
    await captureReasoningVisualEvidence({ silent: true });
  }

  agent.status = "running";
  agent.error = "";
  agent.startedAt = new Date().toISOString();
  agent.finishedAt = "";
  agent.summary = "";
  agent.timeline = [];
  agent.toolStages = [];
  agent.processLog = [];
  agent.selectedTimelineIndex = -1;
  render({ preserveBoundInput: true });

  try {
    const payload = buildVlmAgentRequestPayload();
    const result = await api.runVlmAgentAnalysis(payload);
    const timeline = (Array.isArray(result?.timeline) ? result.timeline : []).map((item) => {
      const normalizedItem = item && typeof item === "object" ? item : {};
      return {
        ...normalizeAgentFocus(normalizedItem),
        stageId: normalizedItem.stageId || "",
        title: normalizedItem.title || "分析阶段",
        detail: normalizedItem.detail || "",
      };
    });

    agent.status = "ready";
    agent.error = "";
    agent.finishedAt = new Date().toISOString();
    agent.model = result?.model || "";
    agent.endpoint = result?.endpoint || "";
    agent.instruction = result?.instruction || agent.instruction;
    agent.summary = result?.summary || "";
    agent.confidence = Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : 0;
    agent.timeline = timeline;
    agent.selectedTimelineIndex = timeline.length ? 0 : -1;
    agent.suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];
    agent.usage = result?.usage || null;
    agent.evidence = result?.evidence || null;
    agent.contextStats = result?.contextStats || null;
    agent.processLog = Array.isArray(result?.processLog) ? result.processLog : [];
    agent.toolStages = Array.isArray(result?.toolStages) ? result.toolStages : [];
    agent.raw = result?.raw || null;
    appendAgentChatMessage("assistant", result?.summary || "任务已完成。");

    pushToast("VLM 分析完成，左侧流程与右侧模型已联动。", "success");
  } catch (error) {
    agent.status = "error";
    agent.error = error?.message || String(error);
    agent.finishedAt = new Date().toISOString();
    appendAgentChatMessage("assistant", `执行失败：${agent.error}`);
    pushToast(`VLM 分析失败：${agent.error}`, "error");
  }

  render({ preserveBoundInput: true });
}

function applyReasoningOverlay(overlay) {
  if (!state.workbench) {
    return;
  }

  state.workbench.reasoning.overlay = overlay
    ? { ...createEmptyReasoningOverlay(), ...overlay }
    : createEmptyReasoningOverlay();

  if (state.viewer && state.workbench.workspaceMode === "reasoning") {
    syncViewerState();
  }
}

function applyReasoningMatingFaceHighlight(baseFaceId, assemblingFaceId) {
  if (!state.workbench) {
    return;
  }

  const reasoning = state.workbench.reasoning;
  reasoning.selection.highlightedBaseFaceId = baseFaceId || null;
  reasoning.selection.highlightedAssemblingFaceId = assemblingFaceId || null;

  const stepOverlay = reasoning.data.stepOverlay || createEmptyReasoningOverlay();
  const overlay = {
    ...stepOverlay,
    baseFaceIds: baseFaceId ? [baseFaceId] : stepOverlay.baseFaceIds || [],
    assemblingFaceIds: assemblingFaceId ? [assemblingFaceId] : stepOverlay.assemblingFaceIds || [],
  };
  applyReasoningOverlay(overlay);
}

async function captureReasoningVisualEvidence(options = {}) {
  if (!state.workbench || !state.activeProject || !state.viewer) {
    return null;
  }

  const reasoning = state.workbench.reasoning;
  const explanation = reasoning.data.stepExplanation;
  if (!explanation) {
    return null;
  }

  const baseFaceIds = reasoning.selection.highlightedBaseFaceId
    ? [reasoning.selection.highlightedBaseFaceId]
    : explanation.matingFaces?.map((item) => item.baseFaceId).filter(Boolean) || [];
  const assemblingFaceIds = reasoning.selection.highlightedAssemblingFaceId
    ? [reasoning.selection.highlightedAssemblingFaceId]
    : explanation.matingFaces?.map((item) => item.partFaceId).filter(Boolean) || [];

  try {
    const evidence = await state.viewer.captureCandidateOverlay(
      {
        ...(reasoning.data.stepOverlay || createEmptyReasoningOverlay()),
        baseFaceIds,
        assemblingFaceIds,
      },
      {
        width: options.width || 540,
        height: options.height || 320,
        fit: options.fit !== false,
      },
    );
    reasoning.data.stepVisualEvidence = evidence;
    reasoning.data.stepVisualEvidenceError = "";
    return evidence;
  } catch (error) {
    reasoning.data.stepVisualEvidence = null;
    reasoning.data.stepVisualEvidenceError = error?.message || String(error);
    if (!options.silent) {
      render();
    }
    return null;
  }
}
async function refreshReasoningData() {
  if (!state.activeProject || !state.workbench) {
    return;
  }

  const reasoning = state.workbench.reasoning;
  const projectId = state.activeProject.manifest.projectId;
  reasoning.status = "loading";
  reasoning.error = "";
  reasoning.data.stepExplanation = null;
  reasoning.data.stepPreview = null;
  reasoning.data.stepPreviewError = "";
  reasoning.data.stepVisualEvidence = null;
  reasoning.data.stepVisualEvidenceError = "";
  render();

  try {
    const [summary, constraints, planPayload] = await Promise.all([
      api.getReasoningSummary(projectId),
      api.getReasoningConstraints(getReasoningSelectionPayload()),
      api.getReasoningPlan({
        projectId,
        basePartId: reasoning.selection.basePartId || undefined,
        sequenceId: reasoning.selection.sequenceId || undefined,
        stepIndex: reasoning.selection.stepIndex || undefined,
      }),
    ]);

    reasoning.data.summary = summary;
    reasoning.data.basePartCandidates = constraints.basePartCandidates || [];
    reasoning.data.matingCandidates = constraints.matingCandidates || [];
    reasoning.data.insertionCandidates = constraints.insertionCandidates || [];
    reasoning.data.selectedPair = constraints.selectedPair || null;
    reasoning.data.constraintsOverlay = constraints.overlay || createEmptyReasoningOverlay();
    reasoning.data.plan = planPayload.plan || null;

    reasoning.selection.basePartId = constraints.selection?.basePartId || reasoning.selection.basePartId || summary.bestBasePartId || null;
    reasoning.selection.assemblingPartId = constraints.selection?.assemblingPartId || reasoning.selection.assemblingPartId || null;

    const selectedSequence =
      (planPayload.plan?.candidateSequences || []).find((item) => item.sequenceId === reasoning.selection.sequenceId) ||
      planPayload.plan?.candidateSequences?.[0] ||
      null;
    reasoning.selection.sequenceId = selectedSequence?.sequenceId || null;

    const selectedStep =
      selectedSequence?.steps.find((item) => item.stepIndex === Number(reasoning.selection.stepIndex || 0)) ||
      selectedSequence?.steps?.[0] ||
      null;
    reasoning.selection.stepIndex = selectedStep?.stepIndex || null;

    applyReasoningOverlay(reasoning.data.constraintsOverlay);
    await loadReasoningTransform({ silent: true });
    await loadReasoningStep({ silent: true });
    if (!reasoning.data.relativeTransform && reasoning.selection.basePartId && reasoning.selection.assemblingPartId) {
      await loadReasoningTransform({ silent: true });
    }

    reasoning.status = "ready";
    reasoning.error = "";
    reasoning.refreshedAt = new Date().toISOString();
  } catch (error) {
    reasoning.status = "error";
    reasoning.error = error?.message || String(error);
  }

  render();
}

async function selectReasoningBasePart(basePartId) {
  if (!state.workbench) {
    return;
  }

  state.workbench.reasoning.selection.basePartId = basePartId || null;
  state.workbench.reasoning.selection.assemblingPartId = null;
  state.workbench.reasoning.selection.sequenceId = null;
  state.workbench.reasoning.selection.stepIndex = null;
  state.workbench.reasoning.selection.highlightedBaseFaceId = null;
  state.workbench.reasoning.selection.highlightedAssemblingFaceId = null;
  await refreshReasoningData();
}
async function selectReasoningPair(basePartId, assemblingPartId) {
  if (!state.workbench || !state.activeProject) {
    return;
  }

  const reasoning = state.workbench.reasoning;
  reasoning.selection.basePartId = basePartId || null;
  reasoning.selection.assemblingPartId = assemblingPartId || null;
  reasoning.selection.highlightedBaseFaceId = null;
  reasoning.selection.highlightedAssemblingFaceId = null;
  reasoning.error = "";
  render();

  try {
    const constraints = await api.getReasoningConstraints(getReasoningSelectionPayload());
    reasoning.data.basePartCandidates = constraints.basePartCandidates || reasoning.data.basePartCandidates;
    reasoning.data.matingCandidates = constraints.matingCandidates || reasoning.data.matingCandidates;
    reasoning.data.insertionCandidates = constraints.insertionCandidates || [];
    reasoning.data.selectedPair = constraints.selectedPair || null;
    reasoning.data.constraintsOverlay = constraints.overlay || createEmptyReasoningOverlay();
    applyReasoningOverlay(reasoning.data.constraintsOverlay);
    await loadReasoningTransform({ silent: true });
    render();
  } catch (error) {
    reasoning.error = error?.message || String(error);
    render();
  }
}
async function selectReasoningSequence(sequenceId) {
  if (!state.workbench) {
    return;
  }

  const reasoning = state.workbench.reasoning;
  reasoning.selection.sequenceId = sequenceId || null;
  reasoning.selection.highlightedBaseFaceId = null;
  reasoning.selection.highlightedAssemblingFaceId = null;
  const sequence = getReasoningSequence(sequenceId);
  reasoning.selection.stepIndex = sequence?.steps?.[0]?.stepIndex || null;
  await loadReasoningStep({ silent: true });
  render();
}
async function selectReasoningStep(sequenceId, stepIndex) {
  if (!state.workbench) {
    return;
  }

  state.workbench.reasoning.selection.sequenceId = sequenceId || null;
  state.workbench.reasoning.selection.stepIndex = Number(stepIndex) || null;
  state.workbench.reasoningPanel = "steps";
  await loadReasoningStep();
}

async function loadReasoningTransform(options = {}) {
  if (!state.workbench || !state.activeProject) {
    return null;
  }

  const reasoning = state.workbench.reasoning;
  const { basePartId, assemblingPartId } = reasoning.selection;
  if (!basePartId || !assemblingPartId) {
    reasoning.data.relativeTransform = null;
    reasoning.data.interference = null;
    return null;
  }

  try {
    const payload = await api.getReasoningTransform(getReasoningSelectionPayload());
    reasoning.data.relativeTransform = payload.relativeTransform;
    reasoning.data.insertionCandidates = payload.insertionCandidates || reasoning.data.insertionCandidates;
    reasoning.data.interference = payload.interference || null;
    reasoning.data.transformOverlay = payload.overlay || createEmptyReasoningOverlay();
    reasoning.selection.basePartId = payload.selection?.basePartId || reasoning.selection.basePartId;
    reasoning.selection.assemblingPartId = payload.selection?.assemblingPartId || reasoning.selection.assemblingPartId;
    if (state.workbench.reasoningPanel === "transform") {
      applyReasoningOverlay(reasoning.data.transformOverlay);
    }
    if (!options.silent) {
      render();
    }
    return payload;
  } catch (error) {
    if (!options.silent) {
      reasoning.error = error?.message || String(error);
      render();
    }
    return null;
  }
}

async function loadReasoningStep(options = {}) {
  if (!state.workbench || !state.activeProject) {
    return null;
  }

  const reasoning = state.workbench.reasoning;
  if (!reasoning.selection.sequenceId) {
    reasoning.data.stepExplanation = null;
    reasoning.data.stepPreview = null;
    reasoning.data.stepPreviewError = "";
    reasoning.data.stepVisualEvidence = null;
    reasoning.data.stepVisualEvidenceError = "";
    return null;
  }

  try {
    const payload = await api.getReasoningStep(getReasoningSelectionPayload());
    reasoning.data.stepExplanation = payload;
    reasoning.data.stepOverlay = payload.overlay || createEmptyReasoningOverlay();
    reasoning.selection.sequenceId = payload.sequenceId;
    reasoning.selection.stepIndex = payload.stepIndex;
    reasoning.selection.basePartId = payload.basePart?.partId || reasoning.selection.basePartId;
    reasoning.selection.assemblingPartId = payload.assemblingPart?.partId || reasoning.selection.assemblingPartId;
    reasoning.selection.highlightedBaseFaceId = payload.matingFaces?.[0]?.baseFaceId || null;
    reasoning.selection.highlightedAssemblingFaceId = payload.matingFaces?.[0]?.partFaceId || null;
    applyReasoningMatingFaceHighlight(
      reasoning.selection.highlightedBaseFaceId,
      reasoning.selection.highlightedAssemblingFaceId,
    );

    reasoning.data.stepPreview = null;
    reasoning.data.stepPreviewError = "";
    reasoning.data.stepVisualEvidence = null;
    reasoning.data.stepVisualEvidenceError = "";
    if (state.viewer && options.capturePreview !== false) {
      try {
        reasoning.data.stepPreview = await api.captureReasoningStepPreview({
          ...getReasoningSelectionPayload(),
          width: 540,
          height: 300,
          fit: true,
        });
      } catch (previewError) {
        reasoning.data.stepPreviewError = previewError?.message || String(previewError);
      }
    }

    if (state.viewer) {
      await captureReasoningVisualEvidence({ silent: true });
    }

    if (!options.silent) {
      render();
    }
    return payload;
  } catch (error) {
    if (!options.silent) {
      reasoning.error = error?.message || String(error);
      render();
    }
    return null;
  }
}
function destroyViewer() {
  if (state.viewer) {
    state.viewer.destroy();
    state.viewer = null;
  }
}

function captureBoundInputState() {
  const activeElement = document.activeElement;
  if (!activeElement?.dataset?.bind) {
    return null;
  }

  if (
    !(activeElement instanceof HTMLInputElement) &&
    !(activeElement instanceof HTMLTextAreaElement) &&
    !(activeElement instanceof HTMLSelectElement)
  ) {
    return null;
  }

  return {
    bind: activeElement.dataset.bind,
    value: activeElement.value,
    selectionStart: "selectionStart" in activeElement ? activeElement.selectionStart : null,
    selectionEnd: "selectionEnd" in activeElement ? activeElement.selectionEnd : null,
  };
}

function restoreBoundInputState(snapshot) {
  if (!snapshot?.bind) {
    return;
  }

  const nextElement = root.querySelector(`[data-bind="${snapshot.bind}"]`);
  if (!nextElement) {
    return;
  }

  nextElement.focus({ preventScroll: true });
  if ("value" in nextElement && nextElement.value !== snapshot.value) {
    nextElement.value = snapshot.value;
  }
  if (
    typeof nextElement.setSelectionRange === "function" &&
    typeof snapshot.selectionStart === "number" &&
    typeof snapshot.selectionEnd === "number"
  ) {
    nextElement.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
}

function captureScrollState() {
  return {
    windowX: window.scrollX || 0,
    windowY: window.scrollY || 0,
    elements: Array.from(root.querySelectorAll("[data-preserve-scroll]")).map((element) => ({
      key: element.dataset.preserveScroll,
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
    })),
  };
}

function restoreScrollState(snapshot) {
  if (!snapshot) {
    return;
  }

  window.scrollTo(snapshot.windowX || 0, snapshot.windowY || 0);
  snapshot.elements.forEach((item) => {
    if (!item?.key) {
      return;
    }
    const element = root.querySelector(`[data-preserve-scroll="${item.key}"]`);
    if (!element) {
      return;
    }
    element.scrollTop = item.scrollTop || 0;
    element.scrollLeft = item.scrollLeft || 0;
  });
}

function render(options = {}) {
  const boundInputState = options.preserveBoundInput ? captureBoundInputState() : null;
  const scrollState = captureScrollState();
  const viewerSnapshot = state.route.page === "workbench" ? state.viewer?.snapshot() || null : null;
  document.body.classList.toggle("workbench-mode", state.route.page === "workbench");
  root.innerHTML = `${state.route.page === "workbench" ? renderWorkbenchPage() : renderHomePageWireframe()}${renderToasts()}`;
  if (state.route.page === "workbench") {
    mountViewer(viewerSnapshot);
  } else {
    destroyViewer();
  }

  if (boundInputState) {
    restoreBoundInputState(boundInputState);
  }

  restoreScrollState(scrollState);

  toggleDragMask(state.globalDragging);
  publishMcpState();
}

function renderHomePageWireframe() {
  const filteredProjects = getFilteredProjects();
  const readyCount = state.projects.filter((project) => project.status === "ready").length;
  const parsingCount = state.projects.filter((project) => project.status === "parsing").length;
  const failedCount = state.projects.filter((project) => project.status === "failed").length;
  const mcpSummary = state.mcpServerStatus?.ok ? `MCP ${state.mcpServerStatus.port}` : "MCP 未启动";

  return `    <main class="page home-page">
      <section class="topbar glass-panel home-topbar">
        <div class="brand-lockup">
          <div class="brand-mark"></div>
          <div class="brand-text">
            <h1>STEP Workbench MVP</h1>
            <p>首页聚焦 STEP 导入、项目浏览和工作台入口，方便我们快速进入模型分析。</p>
          </div>
        </div>
        <div class="home-actions">
          <input
            type="search"
            placeholder="搜索项目 / 文件"
            value="${escapeHtml(state.searchText)}"
            data-bind="home-search"
          />
          <select data-bind="home-filter">
            ${renderStatusOptionsWireframe(state.filterStatus)}
          </select>
          <button class="primary-button" data-action="pick-step">
            <span>导入 STEP</span>
          </button>
        </div>
      </section>

      <section class="upload-zone home-upload-zone ${state.globalDragging ? "is-dragging" : ""}" data-action="pick-step">
        <div class="home-upload-copy">
          <button class="secondary-button upload-zone-cta" data-action="pick-step">上传 STEP</button>
          <h2>拖拽文件到这里，或点击按钮选择本地 STEP 模型</h2>
          <p>支持 <code>.step / .stp</code>，导入后会自动创建项目卡片并进入解析流程。</p>
        </div>
      </section>

      <section class="section-head home-section-head">
        <div class="section-title">
          <h3>项目卡片</h3>
          <p data-role="home-result-copy">共 ${filteredProjects.length} 个结果，按最近更新时间排序。</p>
        </div>
        <div class="home-summary">
          <span class="summary-pill">全部 ${state.projects.length}</span>
          <span class="summary-pill">可打开 ${readyCount}</span>
          <span class="summary-pill">解析中 ${parsingCount}</span>
          <span class="summary-pill">异常 ${failedCount}</span>
          <span class="summary-pill">${escapeHtml(mcpSummary)}</span>
        </div>
      </section>

      <div data-role="home-results-slot">${renderHomeResultsSection(filteredProjects)}</div>
    </main>
  `;
}

function renderHomeResultsSection(filteredProjects = getFilteredProjects()) {
  return filteredProjects.length
    ? `<section class="project-grid project-grid-fixed">${filteredProjects.map((project) => renderProjectCardWireframe(project)).join("")}</section>`
    : `
      <section class="empty-state glass-panel">
        <h3>还没有匹配的项目</h3>
        <p>可以先导入一个 STEP 文件生成项目卡片，或者调整搜索词和筛选条件重新查看。</p>
      </section>
    `;
}

function renderStatusOptionsWireframe(selected) {
  const options = [
    { value: "all", label: "全部状态" },
    { value: "ready", label: "可打开" },
    { value: "parsing", label: "解析中" },
    { value: "failed", label: "解析失败" },
    { value: "pending", label: "待处理" },
  ];

  return options
    .map(
      (option) =>
        `<option value="${option.value}" ${selected === option.value ? "selected" : ""}>${option.label}</option>`,
    )
    .join("");
}

function updateHomeResultsSection() {
  const filteredProjects = getFilteredProjects();
  const resultCopy = root.querySelector('[data-role="home-result-copy"]');
  const resultSlot = root.querySelector('[data-role="home-results-slot"]');

  if (state.openProjectMenuId && !filteredProjects.some((project) => project.projectId === state.openProjectMenuId)) {
    state.openProjectMenuId = null;
  }

  if (resultCopy) {
    resultCopy.textContent = `共 ${filteredProjects.length} 个结果，按最近更新时间排序。`;
  }

  if (resultSlot) {
    resultSlot.innerHTML = renderHomeResultsSection(filteredProjects);
  }
}

function renderProjectCardWireframe(project) {
  const progress = normalizeProgress(project.progress);
  const meta = {
    pending: { label: "待处理", className: "status-pending" },
    parsing: { label: "解析中", className: "status-parsing" },
    ready: { label: "可打开", className: "status-ready" },
    failed: { label: "解析失败", className: "status-failed" },
  }[project.status] || { label: "待处理", className: "status-pending" };
  const clickable = project.status === "ready";
  const menuOpen = state.openProjectMenuId === project.projectId;
  const openAction = clickable ? `data-action="open-project" data-project-id="${project.projectId}"` : "";

  return `
    <article class="project-card project-card-fixed ${clickable ? "is-clickable" : ""}" data-project-id="${project.projectId}">
      <div class="project-card-frame">
        <div class="project-card-topline">
          <div class="project-card-media">
            <div class="thumbnail-frame project-thumbnail ${project.thumbnailDataUrl ? "" : "is-empty"}" ${openAction}>
              ${project.thumbnailDataUrl ? `<img alt="${escapeHtml(project.projectName)}" src="${project.thumbnailDataUrl}" />` : ""}
            </div>
          </div>
          <div class="project-card-main">
            <div class="project-meta ${clickable ? "project-meta-link" : ""}" ${openAction}>
              <h4>${escapeHtml(project.projectName)}</h4>
              <p>${escapeHtml(project.sourceFileName)}</p>
            </div>
            <span class="status-pill project-status-pill ${meta.className}">${meta.label}${project.status === "parsing" ? ` ${progress}%` : ""}</span>
          </div>
          <div class="project-menu" data-role="project-menu">
            <button
              class="project-menu-button ${menuOpen ? "is-open" : ""}"
              type="button"
              data-action="toggle-project-menu"
              data-project-id="${project.projectId}"
              aria-expanded="${menuOpen ? "true" : "false"}"
              aria-label="更多操作"
            >
              ...
            </button>
            ${
              menuOpen
                ? `
                  <div class="project-menu-panel glass-panel" data-role="project-menu">
                    ${clickable ? `<button class="project-menu-item" type="button" data-action="open-project" data-project-id="${project.projectId}">打开工作台</button>` : ""}
                    ${project.status === "failed" ? `<button class="project-menu-item" type="button" data-action="retry-project" data-project-id="${project.projectId}">重新解析</button>` : ""}
                    <button class="project-menu-item" type="button" data-action="rename-project" data-project-id="${project.projectId}">重命名</button>
                    <button class="project-menu-item" type="button" data-action="open-source-dir" data-project-id="${project.projectId}">打开源目录</button>
                    <button class="project-menu-item is-danger" type="button" data-action="delete-project" data-project-id="${project.projectId}">删除项目</button>
                  </div>
                `
                : ""
            }
          </div>
        </div>
        <div class="project-card-bottom">
          <div class="project-facts-grid">
            <span>装配数 <strong>${project.assemblyCount || "-"}</strong></span>
            <span>零件数 <strong>${project.partCount || "-"}</strong></span>
            <span>大小 <strong>${formatBytes(project.sourceFileSize)}</strong></span>
          </div>
          ${
            project.status === "parsing"
              ? `
                <div class="progress-block project-feedback">
                  <div class="progress-copy">
                    <span>${escapeHtml(project.currentStage || "解析中")}</span>
                    <strong>${progress}%</strong>
                  </div>
                  <div class="progress-track">
                    <div class="progress-value" style="width: ${progress}%"></div>
                  </div>
                </div>
              `
              : project.status === "failed"
                ? `<div class="error-box project-feedback">${escapeHtml(project.errorSummary || "解析失败，请重试。")}</div>`
                : `<div class="project-updated-time">更新时间：${formatDateTime(project.updatedAt)}</div>`
          }
        </div>
      </div>
    </article>
  `;
}

function renderHomePage() {
  return renderHomePageWireframe();
}

function renderStatusOptions(selected) {
  return renderStatusOptionsWireframe(selected);
}

function renderProjectCard(project) {
  return renderProjectCardWireframe(project);
}
function renderWorkbenchPage() {
  if (state.loadingProjectId || !state.activeProject || !state.workbench) {
    return `
      <div class="loading-state">
        <div class="loading-card glass-panel">
          <h2>正在准备工作台</h2>
          <p>正在读取项目缓存与装配结构，请稍候片刻。</p>
        </div>
      </div>
    `;
  }

  const { manifest } = state.activeProject;
  const reasoning = state.workbench.reasoning;
  const isReasoningMode = state.workbench.workspaceMode === "reasoning";
  const isAgentPanelActive = !isReasoningMode && state.workbench.activePanel === "agent";
  const usesReasoningViewerContext = isReasoningMode;
  const selectedLabel = getSelectionLabel();
  const visiblePartCount = getVisiblePartCount();
  const hiddenPartCount = state.activeProject.partNodes.length - visiblePartCount;
  const activePanelMeta = getActivePanelMeta();
  const navigation = isReasoningMode ? REASONING_PANEL_META : PANEL_META;
  const currentStep = reasoning.data.stepExplanation;
  const agentAnalysis = reasoning.data.agentAnalysis;
  const currentAgentTimelineStep =
    isAgentPanelActive && agentAnalysis.selectedTimelineIndex >= 0
      ? agentAnalysis.timeline?.[agentAnalysis.selectedTimelineIndex] || null
      : null;
  const focusBaseName = getPartDisplayName(currentAgentTimelineStep?.basePartId || reasoning.selection.basePartId);
  const focusAssemblingName = getPartDisplayName(
    currentAgentTimelineStep?.assemblingPartId || reasoning.selection.assemblingPartId,
  );
  const reasoningStepLabel =
    isAgentPanelActive
      ? currentAgentTimelineStep
        ? currentAgentTimelineStep.title || `流程阶段 ${agentAnalysis.selectedTimelineIndex + 1}`
        : agentAnalysis.status === "running"
          ? "VLM 分析中..."
          : "还未选择流程阶段"
      : currentStep
        ? `${currentStep.sequenceId} / Step ${currentStep.stepIndex}`
        : "选择候选或步骤后联动 viewer";

  return `
    <main class="workbench-shell">
      <header class="workbench-toolbar">
        <div class="toolbar-cluster toolbar-cluster-main">
          <button class="secondary-button" data-action="go-home">返回首页</button>
          <div class="toolbar-title">
            <strong>${escapeHtml(manifest.projectName)}</strong>
            <span>${escapeHtml(manifest.sourceFileName)}</span>
          </div>
          ${renderWorkspaceModeSwitch()}
        </div>
        <div class="toolbar-cluster toolbar-cluster-actions">
          <button class="toolbar-button" data-action="viewer-fit">适配</button>
          ${["front", "left", "top", "right", "back", "bottom"].map((preset) => renderPresetButton(preset)).join("")}
          <button class="toolbar-button ${state.workbench.selectionMode === "face" ? "is-active" : ""}" data-action="toggle-selection-mode">
            ${state.workbench.selectionMode === "face" ? "面级选择" : "零件选择"}
          </button>
          ${
            isReasoningMode
              ? `<button class="toolbar-button ${reasoning.status === "loading" ? "is-active" : ""}" data-action="refresh-reasoning">刷新推理</button>`
              : `
                <button class="toolbar-button ${state.workbench.isolatedNodeIds ? "is-active" : ""}" data-action="isolate-selection">隔离</button>
                <button class="toolbar-button ${state.workbench.measure.enabled ? "is-active" : ""}" data-action="toggle-measure">测量</button>
                <button class="toolbar-button ${state.workbench.section.enabled ? "is-active" : ""}" data-action="toggle-section">剖切</button>
              `
          }
          <button class="toolbar-button" data-action="save-screenshot">截图</button>
        </div>
      </header>

      <section class="workbench-body ${isReasoningMode ? "is-reasoning" : ""}">
        <nav class="nav-rail" data-preserve-scroll="workbench-nav">
          ${Object.entries(navigation)
            .map(([key, panel]) => {
              const isActive = isReasoningMode ? key === state.workbench.reasoningPanel : key === state.workbench.activePanel;
              return `
                <button
                  class="nav-button ${isActive ? "is-active" : ""}"
                  data-action="${isReasoningMode ? "set-reasoning-panel" : "set-panel"}"
                  data-panel="${key}"
                >
                  <strong>${panel.icon}</strong>
                  <span>${panel.title}</span>
                </button>
              `;
            })
            .join("")}
        </nav>

        <aside class="side-panel ${isReasoningMode ? "reasoning-side-panel" : ""}">
          <div class="side-panel-header">
            <h3>${activePanelMeta?.title || "工作台"}</h3>
            <p>${activePanelMeta?.description || ""}</p>
          </div>
          <div class="side-panel-scroll" data-preserve-scroll="workbench-side-panel">
            ${renderWorkbenchPanel()}
          </div>
        </aside>

        <section class="viewer-shell">
          <div class="viewer-grid"></div>
          <canvas id="viewer-canvas" class="viewer-canvas"></canvas>
          <div class="viewer-overlay-top">
            <div class="viewer-chip"><strong>工作区</strong><span>${isReasoningMode ? "装配推理" : "模型工作台"}</span></div>
            <div class="viewer-chip"><strong>选择模式</strong><span>${state.workbench.selectionMode === "face" ? "面级" : "零件级"}</span></div>
            <div class="viewer-chip"><strong>${usesReasoningViewerContext ? "推理状态" : "当前剖切"}</strong><span>${usesReasoningViewerContext ? getReasoningStatusLabel(reasoning.status) : state.workbench.section.enabled ? `${state.workbench.section.axis.toUpperCase()} = ${Math.round(state.workbench.section.offset)}` : "关闭"}</span></div>
          </div>
          <div class="viewer-floating ${usesReasoningViewerContext ? "is-visible" : ""}">
            <div class="floating-card">
              <h4>${usesReasoningViewerContext ? "推理焦点" : "当前选中"}</h4>
              <p>${usesReasoningViewerContext ? `${escapeHtml(focusBaseName)} -> ${escapeHtml(focusAssemblingName)}` : escapeHtml(selectedLabel)}</p>
            </div>
            <div class="floating-card">
              <h4>${usesReasoningViewerContext ? "当前步骤" : "显示摘要"}</h4>
              <p>${usesReasoningViewerContext ? escapeHtml(reasoningStepLabel) : `可见零件 ${visiblePartCount} / ${state.activeProject.partNodes.length}，隐藏 ${hiddenPartCount}`}</p>
            </div>
          </div>
          <div class="viewer-overlay-bottom">
            <div class="viewer-chip"><strong>操作提示</strong><span data-role="viewer-hint">${escapeHtml(state.workbench.viewerHint)}</span></div>
            <div class="viewer-chip"><strong>${usesReasoningViewerContext ? "当前聚焦" : "对象状态"}</strong><span>${usesReasoningViewerContext ? `${escapeHtml(focusBaseName)} / ${escapeHtml(focusAssemblingName)}` : state.workbench.isolatedNodeIds ? "隔离中" : "显示全部 / 自定义显隐"}</span></div>
          </div>
        </section>
      </section>

      <footer class="statusbar">
        <div class="status-items">
          <span>项目：<strong>${escapeHtml(manifest.projectName)}</strong></span>
          <span>工作区：<strong>${isReasoningMode ? "装配推理" : "模型工作台"}</strong></span>
          <span>选中对象：<strong>${escapeHtml(selectedLabel)}</strong></span>
          <span>零件 / 面数：<strong>${manifest.partCount} / ${manifest.faceCount}</strong></span>
          ${usesReasoningViewerContext ? `<span>当前步骤：<strong>${escapeHtml(reasoningStepLabel)}</strong></span>` : ""}
        </div>
        <span data-role="status-hint">${escapeHtml(state.workbench.viewerHint)}</span>
      </footer>
    </main>
  `;
}

function renderWorkspaceModeSwitch() {
  return `
    <div class="workspace-switch">
      <button class="workspace-switch-button ${state.workbench.workspaceMode === "model" ? "is-active" : ""}" data-action="set-workspace-mode" data-workspace-mode="model">模型工作台</button>
      <button class="workspace-switch-button ${state.workbench.workspaceMode === "reasoning" ? "is-active" : ""}" data-action="set-workspace-mode" data-workspace-mode="reasoning">装配推理</button>
    </div>
  `;
}
function renderPresetButton(preset) {
  const labelMap = {
    front: "前视",
    left: "左视",
    top: "顶视",
    right: "右视",
    back: "后视",
    bottom: "底视",
  };

  return `<button class="toolbar-button" data-action="viewer-preset" data-preset="${preset}">${labelMap[preset]}</button>`;
}
function renderWorkbenchPanel() {
  if (state.workbench.workspaceMode === "reasoning") {
    return renderReasoningPanel();
  }

  switch (state.workbench.activePanel) {
    case "overview":
      return renderOverviewPanel();
    case "assembly":
      return renderAssemblyPanel();
    case "display":
      return renderDisplayPanel();
    case "agent":
      return renderReasoningAgentPanel();
    case "section":
      return renderSectionPanel();
    case "measure":
      return renderMeasurePanel();
    case "properties":
      return renderPropertiesPanel();
    default:
      return "";
  }
}

function renderReasoningPanel() {
  switch (state.workbench.reasoningPanel) {
    case "summary":
      return renderReasoningSummaryPanel();
    case "agent":
      return renderReasoningAgentPanel();
    case "constraints":
      return renderReasoningConstraintsPanel();
    case "transform":
      return renderReasoningTransformPanel();
    case "plan":
      return renderReasoningPlanPanel();
    case "steps":
      return renderReasoningStepPanel();
    default:
      return "";
  }
}

function renderReasoningStatusNotice() {
  const reasoning = state.workbench.reasoning;
  if (reasoning.status === "loading") {
    return `<div class="inline-note reasoning-note">正在刷新装配推理结果...</div>`;
  }
  if (reasoning.status === "error") {
    return `<div class="inline-note reasoning-note is-error">${escapeHtml(reasoning.error || "推理失败")}</div>`;
  }
  if (reasoning.refreshedAt) {
    return `<div class="inline-note reasoning-note">最近更新：${formatDateTime(reasoning.refreshedAt)}</div>`;
  }
  return `<div class="inline-note reasoning-note">还没有运行过推理分析。</div>`;
}

function renderReasoningAgentPanel() {
  const reasoning = state.workbench.reasoning;
  const agent = reasoning.data.agentAnalysis;
  const isRunning = agent.status === "running";
  const processLog = Array.isArray(agent.processLog) ? agent.processLog : [];
  const toolStages = Array.isArray(agent.toolStages) ? agent.toolStages : [];
  const chatMessages = Array.isArray(agent.chatMessages) ? agent.chatMessages : [];

  const latestUserMessage = [...chatMessages].reverse().find((item) => item.role === "user");
  const latestAssistantMessage = [...chatMessages].reverse().find((item) => item.role === "assistant");

  const simplifyAgentText = (text) => {
    const rawText = String(text || "").trim();
    if (!rawText) {
      return "";
    }

    try {
      const parsed = JSON.parse(rawText);
      return parsed?.final?.summary || parsed?.summary || parsed?.stage_goal || parsed?.rationale || rawText;
    } catch {
      return rawText;
    }
  };

  const assistantPreview = simplifyAgentText(latestAssistantMessage?.content || "");

  return `
    <div class="panel-card">
      <div class="panel-actions">
        <h4>任务输入</h4>
        <button class="secondary-button" data-action="send-agent-chat" ${isRunning ? "disabled" : ""}>
          ${isRunning ? "执行中..." : "发送指令"}
        </button>
      </div>
      ${
        latestUserMessage?.content
          ? `<div class="inline-note reasoning-note" style="margin-top: 10px;">最近指令：${escapeHtml(latestUserMessage.content)}</div>`
          : `<div class="inline-note reasoning-note" style="margin-top: 10px;">请输入装配分析任务，工具调用和输出会在下方逐步更新。</div>`
      }
      <textarea
        class="agent-chat-input"
        rows="4"
        placeholder="例如：先定位基准件，再逐步调用工具确认关键配合关系，并输出简洁结论。"
        data-bind="agent-chat-input"
      >${escapeHtml(agent.chatInput || "")}</textarea>
      <div class="overview-grid agent-meta-grid" style="margin-top: 12px;">
        <div class="overview-row"><span>运行状态</span><strong>${getAgentStatusLabel(agent.status)}</strong></div>
        <div class="overview-row"><span>模型</span><strong>${escapeHtml(agent.model || "-")}</strong></div>
        <div class="overview-row"><span>置信度</span><strong>${formatConfidence(agent.confidence || 0)}</strong></div>
        <div class="overview-row"><span>完成时间</span><strong>${escapeHtml(formatDateTime(agent.finishedAt) || "-")}</strong></div>
      </div>
      ${
        agent.status === "error"
          ? `<div class="inline-note reasoning-note is-error" style="margin-top: 10px;">${escapeHtml(agent.error || "VLM 调用失败")}</div>`
          : ""
      }
    </div>

    <div class="panel-card">
      <h4>工具调用（逐步）</h4>
      <div class="reasoning-list">
        ${
          toolStages.length
            ? toolStages
                .map(
                  (item, index) => `
                    <div class="reasoning-item is-static">
                      <strong>${index + 1}. ${escapeHtml(item.toolName || item.title || `步骤 ${index + 1}`)}</strong>
                      <span>${escapeHtml(item.goal || item.detail || "-")}</span>
                    </div>
                  `,
                )
                .join("")
            : `<div class="inline-note">等待智能体开始调用工具...</div>`
        }
      </div>
    </div>

    <div class="panel-card">
      <h4>输出内容（逐步）</h4>
      <div class="reasoning-list">
        ${
          processLog.length
            ? processLog
                .map(
                  (item, index) => `
                    <div class="reasoning-item is-static">
                      <strong>${index + 1}. ${escapeHtml(item.title || item.type || "过程更新")}</strong>
                      <span>${escapeHtml(item.detail || "-")}</span>
                    </div>
                  `,
                )
                .join("")
            : `<div class="inline-note">等待智能体输出阶段结果...</div>`
        }
      </div>
      ${
        agent.summary || assistantPreview
          ? `<div class="inline-note reasoning-note" style="margin-top: 12px;">最终结论：${escapeHtml(agent.summary || assistantPreview)}</div>`
          : ""
      }
      ${
        agent.suggestions?.length
          ? `<div class="reasoning-list" style="margin-top: 12px;">${agent.suggestions
              .map(
                (item) => `
                  <div class="reasoning-item is-static">
                    <strong>建议</strong>
                    <span>${escapeHtml(item)}</span>
                  </div>
                `,
              )
              .join("")}</div>`
          : ""
      }
    </div>
  `;
}

function renderReasoningSummaryPanel() {
  const reasoning = state.workbench.reasoning;
  const summary = reasoning.data.summary;
  return `
    <div class="panel-card">
      <div class="panel-actions">
        <h4>分析概览</h4>
        <button class="secondary-button" data-action="refresh-reasoning">刷新分析</button>
      </div>
      ${renderReasoningStatusNotice()}
      <div class="metric-grid">
        <div class="metric-card"><span>基准件候选</span><strong>${summary?.baseCandidateCount ?? reasoning.data.basePartCandidates.length}</strong></div>
        <div class="metric-card"><span>配合候选</span><strong>${summary?.matingCandidateCount ?? reasoning.data.matingCandidates.length}</strong></div>
        <div class="metric-card"><span>候选序列</span><strong>${summary?.sequenceCount ?? (reasoning.data.plan?.candidateSequences?.length || 0)}</strong></div>
        <div class="metric-card"><span>最高置信度</span><strong>${formatConfidence(summary?.topConfidence || 0)}</strong></div>
      </div>
    </div>
    <div class="panel-card">
      <h4>当前焦点</h4>
      <div class="overview-grid">
        <div class="overview-row"><span>基准件</span><strong>${escapeHtml(getPartDisplayName(reasoning.selection.basePartId))}</strong></div>
        <div class="overview-row"><span>装配件</span><strong>${escapeHtml(getPartDisplayName(reasoning.selection.assemblingPartId))}</strong></div>
        <div class="overview-row"><span>序列</span><strong>${escapeHtml(reasoning.selection.sequenceId || "-")}</strong></div>
        <div class="overview-row"><span>步骤</span><strong>${reasoning.selection.stepIndex || "-"}</strong></div>
      </div>
    </div>
    <div class="panel-card">
      <h4>操作建议</h4>
      <div class="control-grid">
        <button class="secondary-button" data-action="open-model-agent-panel">智能体流程面板</button>
        <button class="secondary-button" data-action="set-reasoning-panel" data-panel="constraints">查看约束发现</button>
        <button class="secondary-button" data-action="set-reasoning-panel" data-panel="plan">查看装配计划</button>
        <button class="secondary-button" data-action="set-reasoning-panel" data-panel="steps">查看步骤讲解</button>
      </div>
    </div>
  `;
}

function renderReasoningConstraintsPanel() {
  const reasoning = state.workbench.reasoning;
  const selectedBasePartId = reasoning.selection.basePartId;
  const selectedAssemblingPartId = reasoning.selection.assemblingPartId;

  return `
    ${renderReasoningStatusNotice()}
    <div class="panel-card">
      <h4>基准件候选</h4>
      <div class="reasoning-list">
        ${
          reasoning.data.basePartCandidates.length
            ? reasoning.data.basePartCandidates
                .map(
                  (candidate) => `
                    <button class="reasoning-item ${candidate.partId === selectedBasePartId ? "is-active" : ""}" data-action="select-reasoning-base" data-base-part-id="${candidate.partId}">
                      <strong>${escapeHtml(getPartDisplayName(candidate.partId))}</strong>
                      <span>score ${formatConfidence(candidate.score)}</span>
                    </button>
                  `,
                )
                .join("")
            : `<div class="inline-note">暂无基准件候选。</div>`
        }
      </div>
    </div>
    <div class="panel-card">
      <h4>配合候选</h4>
      <div class="reasoning-list">
        ${
          reasoning.data.matingCandidates.length
            ? reasoning.data.matingCandidates
                .slice(0, 12)
                .map((pair) => {
                  const pairBaseId = selectedBasePartId ? selectedBasePartId : pair.partAId;
                  const pairAssemblingId = pair.partAId === pairBaseId ? pair.partBId : pair.partAId;
                  const isActive = pairBaseId === selectedBasePartId && pairAssemblingId === selectedAssemblingPartId;
                  return `
                    <button class="reasoning-item ${isActive ? "is-active" : ""}" data-action="select-reasoning-pair" data-base-part-id="${pairBaseId}" data-assembling-part-id="${pairAssemblingId}">
                      <strong>${escapeHtml(getPartDisplayName(pairBaseId))} -> ${escapeHtml(getPartDisplayName(pairAssemblingId))}</strong>
                      <span>${escapeHtml(pair.relation)} / ${formatConfidence(pair.score)}</span>
                    </button>
                  `;
                })
                .join("")
            : `<div class="inline-note">暂无配合候选。</div>`
        }
      </div>
    </div>
    <div class="panel-card">
      <h4>插入方向候选</h4>
      <div class="reasoning-list">
        ${
          reasoning.data.insertionCandidates.length
            ? reasoning.data.insertionCandidates
                .map(
                  (candidate) => `
                    <div class="reasoning-item is-static">
                      <strong>${escapeHtml(getPartDisplayName(candidate.partId))} -> ${escapeHtml(getPartDisplayName(candidate.basePartId))}</strong>
                      <span>axis ${escapeHtml(formatVector(candidate.insertionAxis))} / distance ${formatNumber(candidate.travelDistance)}</span>
                    </div>
                  `,
                )
                .join("")
            : `<div class="inline-note">选择一个配合候选后查看插入方向。</div>`
        }
      </div>
    </div>
  `;
}

function renderReasoningTransformPanel() {
  const reasoning = state.workbench.reasoning;
  const transform = reasoning.data.relativeTransform;
  const interference = reasoning.data.interference;

  return `
    ${renderReasoningStatusNotice()}
    <div class="panel-card">
      <div class="panel-actions">
        <h4>姿态与干涉</h4>
        <button class="secondary-button" data-action="refresh-reasoning-transform">刷新校验</button>
      </div>
      <div class="overview-grid">
        <div class="overview-row"><span>基准件</span><strong>${escapeHtml(getPartDisplayName(reasoning.selection.basePartId))}</strong></div>
        <div class="overview-row"><span>装配件</span><strong>${escapeHtml(getPartDisplayName(reasoning.selection.assemblingPartId))}</strong></div>
        <div class="overview-row"><span>平移</span><strong>${transform ? escapeHtml(formatVector(transform.translation)) : "-"}</strong></div>
        <div class="overview-row"><span>姿态四元数</span><strong>${transform ? escapeHtml(formatQuaternion(transform.quaternion)) : "-"}</strong></div>
      </div>
    </div>
    <div class="panel-card">
      <h4>插入方向</h4>
      <div class="reasoning-list">
        ${
          reasoning.data.insertionCandidates.length
            ? reasoning.data.insertionCandidates
                .map(
                  (candidate) => `
                    <div class="reasoning-item is-static">
                      <strong>${escapeHtml(getPartDisplayName(candidate.partId))}</strong>
                      <span>axis ${escapeHtml(formatVector(candidate.insertionAxis))} / score ${formatConfidence(candidate.score)}</span>
                    </div>
                  `,
                )
                .join("")
            : `<div class="inline-note">暂无插入方向结果。</div>`
        }
      </div>
    </div>
    <div class="panel-card">
      <h4>干涉检查</h4>
      <div class="overview-grid">
        <div class="overview-row"><span>是否干涉</span><strong>${interference ? (interference.hasInterference ? "是" : "否") : "-"}</strong></div>
        <div class="overview-row"><span>碰撞数量</span><strong>${interference?.collisionCount ?? 0}</strong></div>
        <div class="overview-row"><span>总重叠量</span><strong>${formatNumber(interference?.totalOverlapVolume || 0)}</strong></div>
      </div>
      <div class="reasoning-list" style="margin-top: 12px;">
        ${
          interference?.collisions?.length
            ? interference.collisions.map((item) => `
                <div class="reasoning-item is-static">
                  <strong>${escapeHtml(item.partName || item.partId)}</strong>
                  <span>overlap ${formatNumber(item.overlapVolume)}</span>
                </div>
              `).join("")
            : `<div class="inline-note">当前没有检测到干涉。</div>`
        }
      </div>
    </div>
  `;
}

function renderReasoningPlanPanel() {
  const reasoning = state.workbench.reasoning;
  const plan = reasoning.data.plan;
  const sequences = plan?.candidateSequences || [];
  const selectedSequence = getReasoningSequence();

  return `
    ${renderReasoningStatusNotice()}
    <div class="panel-card">
      <h4>候选序列</h4>
      <div class="reasoning-list">
        ${
          sequences.length
            ? sequences
                .map(
                  (sequence) => `
                    <button class="reasoning-item ${sequence.sequenceId === reasoning.selection.sequenceId ? "is-active" : ""}" data-action="select-reasoning-sequence" data-sequence-id="${sequence.sequenceId}">
                      <strong>${escapeHtml(sequence.sequenceId)} / ${escapeHtml(getPartDisplayName(sequence.basePartId))}</strong>
                      <span>confidence ${formatConfidence(sequence.confidence)} / steps ${sequence.steps.length}</span>
                    </button>
                  `,
                )
                .join("")
            : `<div class="inline-note">暂无装配序列。</div>`
        }
      </div>
    </div>
    <div class="panel-card">
      <h4>当前序列步骤</h4>
      <div class="reasoning-list">
        ${
          selectedSequence?.steps?.length
            ? selectedSequence.steps
                .map(
                  (step) => `
                    <button class="reasoning-item ${step.stepIndex === reasoning.selection.stepIndex ? "is-active" : ""}" data-action="select-reasoning-step" data-sequence-id="${selectedSequence.sequenceId}" data-step-index="${step.stepIndex}">
                      <strong>Step ${step.stepIndex}: ${escapeHtml(getPartDisplayName(step.assemblingPartId))}</strong>
                      <span>base ${escapeHtml(getPartDisplayName(step.basePartId))} / ${formatConfidence(step.confidence)}</span>
                    </button>
                  `,
                )
                .join("")
            : `<div class="inline-note">先选择一个序列查看步骤。</div>`
        }
      </div>
    </div>
    <div class="panel-card">
      <h4>Precedence 摘要</h4>
      <div class="overview-grid">
        <div class="overview-row"><span>节点数</span><strong>${plan?.precedenceGraph?.nodes?.length || 0}</strong></div>
        <div class="overview-row"><span>边数</span><strong>${plan?.precedenceGraph?.edges?.length || 0}</strong></div>
        <div class="overview-row"><span>当前基准件</span><strong>${escapeHtml(selectedSequence ? getPartDisplayName(selectedSequence.basePartId) : "-")}</strong></div>
      </div>
    </div>
  `;
}

function renderReasoningStepPanel() {
  const reasoning = state.workbench.reasoning;
  const explanation = reasoning.data.stepExplanation;
  const preview = reasoning.data.stepPreview;
  const visualEvidence = reasoning.data.stepVisualEvidence;
  const baseFaceEntry = getFaceColorMapEntry(reasoning.selection.highlightedBaseFaceId);
  const assemblingFaceEntry = getFaceColorMapEntry(reasoning.selection.highlightedAssemblingFaceId);

  if (!explanation) {
    return `
      ${renderReasoningStatusNotice()}
      <div class="panel-card">
        <h4>尚未选择步骤</h4>
        <p>先在“装配计划”里选择一个序列或步骤，这里会展示单步说明和预览。</p>
      </div>
    `;
  }

  return `
    ${renderReasoningStatusNotice()}
    <div class="panel-card">
      <div class="panel-actions">
        <h4>${escapeHtml(explanation.title)}</h4>
        <button class="secondary-button" data-action="refresh-reasoning-step">刷新步骤</button>
      </div>
      <p>${escapeHtml(explanation.summary)}</p>
      <div class="overview-grid" style="margin-top: 12px;">
        <div class="overview-row"><span>基准件</span><strong>${escapeHtml(explanation.basePart.name)}</strong></div>
        <div class="overview-row"><span>装配件</span><strong>${escapeHtml(explanation.assemblingPart.name)}</strong></div>
        <div class="overview-row"><span>置信度</span><strong>${formatConfidence(explanation.confidence)}</strong></div>
        <div class="overview-row"><span>插入方向</span><strong>${escapeHtml(formatVector(explanation.insertionAxis || { x: 0, y: 0, z: 0 }))}</strong></div>
      </div>
    </div>
    <div class="panel-card">
      <h4>配合证据</h4>
      <div class="reasoning-list">
        ${
          explanation.matingFaces?.length
            ? explanation.matingFaces
                .map((item) => {
                  const isActive =
                    reasoning.selection.highlightedBaseFaceId === item.baseFaceId &&
                    reasoning.selection.highlightedAssemblingFaceId === item.partFaceId;
                  return `
                    <button
                      class="reasoning-item ${isActive ? "is-active" : ""}"
                      data-action="highlight-reasoning-mating-face"
                      data-base-face-id="${item.baseFaceId}"
                      data-assembling-face-id="${item.partFaceId}"
                    >
                      <strong>${escapeHtml(item.baseFaceName)} ↔ ${escapeHtml(item.assemblingFaceName)}</strong>
                      <span>${escapeHtml(item.relation || "mate")}</span>
                    </button>
                  `;
                })
                .join("")
            : `<div class="inline-note">当前步骤没有明确的配合面证据。</div>`
        }
      </div>
      <div class="reasoning-list" style="margin-top: 12px;">
        ${
          explanation.evidence?.length
            ? explanation.evidence.map((item) => `<div class="reasoning-item is-static"><strong>Evidence</strong><span>${escapeHtml(item)}</span></div>`).join("")
            : `<div class="inline-note">暂无额外证据。</div>`
        }
      </div>
    </div>
    <div class="panel-card">
      <h4>视觉证据</h4>
      ${
        visualEvidence
          ? `
            <div class="evidence-visual-grid">
              <div class="evidence-visual-item">
                <strong>Candidate Overlay</strong>
                <img class="reasoning-preview reasoning-preview-compact" alt="Candidate Overlay" src="${visualEvidence.overlayDataUrl}" />
              </div>
              <div class="evidence-visual-item">
                <strong>Face Mask</strong>
                <img class="reasoning-preview reasoning-preview-compact" alt="Face Mask" src="${visualEvidence.faceMaskDataUrl}" />
              </div>
            </div>
          `
          : `<div class="inline-note">${escapeHtml(reasoning.data.stepVisualEvidenceError || "当前还没有生成视觉证据。")}</div>`
      }
      <div class="reasoning-list evidence-face-list" style="margin-top: 12px;">
        ${
          baseFaceEntry
            ? `
              <div class="reasoning-item is-static">
                <strong>基准面</strong>
                <span class="evidence-color-row"><span class="evidence-color-chip" style="background:${baseFaceEntry.colorHex}"></span>${escapeHtml(baseFaceEntry.faceName || baseFaceEntry.faceId)} / ${escapeHtml(baseFaceEntry.colorHex)}</span>
              </div>
            `
            : ""
        }
        ${
          assemblingFaceEntry
            ? `
              <div class="reasoning-item is-static">
                <strong>装配面</strong>
                <span class="evidence-color-row"><span class="evidence-color-chip" style="background:${assemblingFaceEntry.colorHex}"></span>${escapeHtml(assemblingFaceEntry.faceName || assemblingFaceEntry.faceId)} / ${escapeHtml(assemblingFaceEntry.colorHex)}</span>
              </div>
            `
            : ""
        }
      </div>
    </div>
    <div class="panel-card">
      <h4>步骤预览</h4>
      ${preview?.dataUrl ? `<img class="reasoning-preview" alt="Step Preview" src="${preview.dataUrl}" />` : `<div class="inline-note">${escapeHtml(reasoning.data.stepPreviewError || "当前还没有生成步骤预览。")}</div>`}
    </div>
  `;
}
function renderOverviewPanel() {
  const { manifest, assembly } = state.activeProject;
  const meta = assembly?.meta || {};
  return `
    <div class="panel-card">
      <h4>项目摘要</h4>
      <div class="overview-grid">
        <div class="overview-row"><span>项目名称</span><strong>${escapeHtml(manifest.projectName)}</strong></div>
        <div class="overview-row"><span>源文件</span><strong class="mono">${escapeHtml(manifest.sourceFileName)}</strong></div>
        <div class="overview-row"><span>解析状态</span><strong>${STATUS_META[manifest.status]?.label || manifest.status}</strong></div>
        <div class="overview-row"><span>零件 / 面数</span><strong>${manifest.partCount} / ${manifest.faceCount}</strong></div>
        <div class="overview-row"><span>装配数</span><strong>${manifest.assemblyCount}</strong></div>
        <div class="overview-row"><span>解析模式</span><strong>${escapeHtml(meta.parserMode || manifest.parserMode || "-")}</strong></div>
        <div class="overview-row"><span>几何模式</span><strong>${escapeHtml(meta.geometryMode || manifest.geometryMode || "-")}</strong></div>
        <div class="overview-row"><span>模型名称</span><strong>${escapeHtml(meta.sourceModelName || manifest.modelName || manifest.projectName)}</strong></div>
        <div class="overview-row"><span>更新时间</span><strong>${formatDateTime(manifest.updatedAt)}</strong></div>
      </div>
    </div>
    <div class="panel-card">
      <h4>缓存结构</h4>
      <p class="mono">project-data/${escapeHtml(manifest.projectId)}/</p>
      <div class="overview-grid">
        <div class="overview-row"><span>源文件缓存</span><strong class="mono">source.step</strong></div>
        <div class="overview-row"><span>元数据</span><strong class="mono">manifest.json</strong></div>
        <div class="overview-row"><span>装配数据</span><strong class="mono">assembly.json</strong></div>
        <div class="overview-row"><span>缩略图</span><strong class="mono">thumbnail.svg</strong></div>
      </div>
    </div>
    <div class="panel-card">
      <h4>边界尺寸</h4>
      <div class="overview-grid">
        <div class="overview-row"><span>X</span><strong>${formatNumber(state.activeProject.assembly.bounds.size.x)}</strong></div>
        <div class="overview-row"><span>Y</span><strong>${formatNumber(state.activeProject.assembly.bounds.size.y)}</strong></div>
        <div class="overview-row"><span>Z</span><strong>${formatNumber(state.activeProject.assembly.bounds.size.z)}</strong></div>
        <div class="overview-row"><span>当前阶段</span><strong>真实 STEP 文本解析</strong></div>
        <div class="overview-row"><span>下一阶段</span><strong>OCCT Sidecar 网格化</strong></div>
      </div>
    </div>
  `;
}

function renderAssemblyPanel() {
  const rootNode = state.activeProject.rootNode;
  return `
    <div class="panel-card">
      <input
        class="search-field"
        type="search"
        placeholder="搜索零件 / 节点"
        value="${escapeHtml(state.workbench.treeSearch)}"
        data-bind="tree-search"
      />
    </div>
    <div class="panel-card">
      <h4>层级结构</h4>
      <div class="tree-list">
        ${rootNode ? renderTreeNode(rootNode.id) : `<div class="inline-note">当前项目没有装配树数据。</div>`}
      </div>
    </div>
  `;
}

function renderTreeNode(nodeId) {
  const node = state.activeProject.nodeMap.get(nodeId);
  if (!node) {
    return "";
  }

  const search = state.workbench.treeSearch.trim().toLowerCase();
  const childMarkup = node.children.map((childId) => renderTreeNode(childId)).join("");
  const selfMatches = !search || node.name.toLowerCase().includes(search);
  const hasVisibleChild = childMarkup.trim().length > 0;

  if (!selfMatches && !hasVisibleChild) {
    return "";
  }

  const isAssembly = node.kind === "assembly";
  const expanded = state.workbench.expandedNodeIds.has(node.id) || node.depth === 0 || Boolean(search);
  const selected = state.workbench.selection?.nodeId === node.id;
  const subtreeHidden = isNodeSubtreeHidden(node.id);

  return `
    <div class="tree-node">
      <div class="tree-row ${selected ? "is-selected" : ""}" data-action="select-node" data-node-id="${node.id}">
        <span class="tree-indent" style="--depth:${Math.max(0, node.depth - 1)}"></span>
        ${
          isAssembly
            ? `<button class="tree-toggle" data-action="toggle-node" data-node-id="${node.id}">${expanded ? "▾" : "▸"}</button>`
            : `<span class="tree-toggle"></span>`
        }
        <span class="tree-kind ${node.kind === "part" ? "kind-part" : ""}"></span>
        <span class="tree-label">${escapeHtml(node.name)}</span>
        ${
          isAssembly
            ? `<span class="tree-badge">${node.stats?.partCount || 0}</span>`
            : `<span class="tree-badge">${formatNumber(maxDimension(node.bbox.size))}</span>`
        }
        <button class="tree-visibility" data-action="toggle-visibility" data-node-id="${node.id}">${subtreeHidden ? "隐" : "显"}</button>
      </div>
      ${isAssembly && expanded ? childMarkup : ""}
    </div>
  `;
}
function renderDisplayPanel() {
  const agent = state.workbench.reasoning.data.agentAnalysis;
  const previewTargetPartIds = resolveAgentTargetPartIds(agent.partQuery).partIds;
  const previewTargetPartNames = previewTargetPartIds.length
    ? previewTargetPartIds.map((partId) => getPartDisplayName(partId)).join(" / ")
    : "当前流程焦点 / 当前选中对象";
  const moveVector = `${formatNumber(agent.moveDirectionX)} / ${formatNumber(agent.moveDirectionY)} / ${formatNumber(agent.moveDirectionZ)}`;
  const faceMapTargetNames = state.workbench.faceMapTargetPartIds?.length
    ? state.workbench.faceMapTargetPartIds.map((partId) => getPartDisplayName(partId)).join(" / ")
    : previewTargetPartNames;
  const canUpdateFaceMapTarget =
    state.workbench.displayMode === "face-map" &&
    previewTargetPartIds.length &&
    !haveSameItems(previewTargetPartIds, state.workbench.faceMapTargetPartIds || []);

  return `
    <div class="panel-card">
      <h4>显示状态</h4>
      <div class="overview-grid">
        <div class="overview-row"><span>可见零件</span><strong>${getVisiblePartCount()}</strong></div>
        <div class="overview-row"><span>隐藏零件</span><strong>${state.activeProject.partNodes.length - getVisiblePartCount()}</strong></div>
        <div class="overview-row"><span>隔离状态</span><strong>${state.workbench.isolatedNodeIds ? "已启用" : "未启用"}</strong></div>
        <div class="overview-row"><span>显示模式</span><strong>${escapeHtml(getDisplayModeLabel(state.workbench.displayMode))}</strong></div>
      </div>
    </div>
    <div class="panel-card">
      <h4>目标对象</h4>
      <p>输入零件 ID 或名称，多个零件可用逗号分隔；留空时默认作用于当前流程焦点或当前选中对象。</p>
      <input
        class="search-field"
        type="text"
        placeholder="例如 part_001, 支架, bolt_A"
        value="${escapeHtml(agent.partQuery || "")}"
        data-bind="agent-part-query"
      />
      <div class="inline-note" style="margin-top: 10px;">当前目标：${escapeHtml(previewTargetPartNames)}</div>
      <div class="control-grid" style="margin-top: 12px;">
        <button class="secondary-button" data-action="agent-isolate-parts">聚焦目标</button>
        <button class="secondary-button" data-action="agent-hide-parts">隐藏目标</button>
        <button class="secondary-button" data-action="reset-display-visibility">恢复默认显示</button>
      </div>
    </div>
    <div class="panel-card">
      <h4>外观</h4>
      <div>
        <div class="panel-actions" style="margin-bottom: 8px;">
          <h5>不透明度</h5>
          <strong>${Math.round((Number(agent.opacityValue) || 0) * 100)}%</strong>
        </div>
        <input
          type="range"
          min="0.05"
          max="1"
          step="0.05"
          value="${Math.max(0.05, Math.min(1, Number(agent.opacityValue) || 1))}"
          data-bind="agent-opacity"
        />
        <p style="margin-top: 10px;">将滑杆调到 100% 再应用，就会恢复默认不透明度。</p>
        <div class="control-grid" style="margin-top: 12px;">
          <button class="secondary-button" data-action="agent-apply-opacity">应用到目标</button>
        </div>
      </div>
      <div style="margin-top: 14px;">
        <div class="panel-actions" style="margin-bottom: 8px;">
          <h5>VLM 面映射</h5>
          <strong>${state.workbench.displayMode === "face-map" ? "已启用" : "未启用"}</strong>
        </div>
        <p>将当前视图切换为高饱和面级配色，帮助 VLM 更稳定地区分零件面的边界与区域。</p>
        <div class="inline-note" style="margin-top: 10px;">当前映射目标：${escapeHtml(faceMapTargetNames)}</div>
        <div class="control-grid" style="margin-top: 12px;">
          <button class="secondary-button" data-action="toggle-face-map-display">
            ${
              state.workbench.displayMode === "face-map"
                ? canUpdateFaceMapTarget
                  ? "更新面映射目标"
                  : "关闭面映射"
                : "开启面映射"
            }
          </button>
        </div>
      </div>
    </div>
    <div class="panel-card">
      <h4>位移控制</h4>
      <div class="panel-actions" style="margin-bottom: 8px;">
        <h5>移动参数</h5>
        <strong>${escapeHtml(moveVector)} / ${formatNumber(agent.moveDistance)} mm</strong>
      </div>
      <p>输入方向向量与距离后，点击按钮将目标零件沿该方向继续移动。</p>
      <div class="agent-vector-grid" style="margin-top: 12px;">
        <input class="search-field" type="number" step="0.1" value="${Number(agent.moveDirectionX) || 0}" data-bind="agent-move-direction-x" placeholder="方向 X" />
        <input class="search-field" type="number" step="0.1" value="${Number(agent.moveDirectionY) || 0}" data-bind="agent-move-direction-y" placeholder="方向 Y" />
        <input class="search-field" type="number" step="0.1" value="${Number(agent.moveDirectionZ) || 0}" data-bind="agent-move-direction-z" placeholder="方向 Z" />
        <input class="search-field" type="number" step="0.1" value="${Number(agent.moveDistance) || 0}" data-bind="agent-move-distance" placeholder="距离 mm" />
      </div>
      <div class="control-grid" style="margin-top: 12px;">
        <button class="secondary-button" data-action="agent-translate-parts">沿指定方向移动零件</button>
        <button class="secondary-button" data-action="agent-reset-translation">恢复默认位置</button>
      </div>
    </div>
    <div class="panel-card">
      <h4>说明</h4>
      <p>显示控制现在分为目标对象、外观和位移三类操作，减少重复入口，同时保留常用能力。</p>
    </div>
  `;
}

function renderSectionPanel() {
  const { section } = state.workbench;
  const bounds = state.activeProject.assembly.bounds;
  const axisBounds = getAxisBounds(section.axis, bounds);
  return `
    <div class="panel-card">
      <h4>剖切开关</h4>
      <div class="toggle-row">
        <span>${section.enabled ? "已启用单平面剖切" : "当前未启用剖切"}</span>
        <button class="secondary-button ${section.enabled ? "is-active" : ""}" data-action="toggle-section">
          ${section.enabled ? "关闭" : "开启"}
        </button>
      </div>
    </div>
    <div class="panel-card">
      <h4>剖切方向</h4>
      <div class="segmented">
        ${["x", "y", "z"]
          .map(
            (axis) => `
              <button class="${section.axis === axis ? "is-active" : ""}" data-action="section-axis" data-axis="${axis}">
                ${axis.toUpperCase()}
              </button>
            `,
          )
          .join("")}
      </div>
      <p style="margin-top: 12px;">保留负向半空间，便于从外部向内部逐步切入。</p>
    </div>
    <div class="panel-card">
      <h4>剖切位置</h4>
      <input
        class="range-field"
        type="range"
        min="${Math.floor(axisBounds.min)}"
        max="${Math.ceil(axisBounds.max)}"
        step="1"
        value="${Math.round(section.offset)}"
        data-bind="section-offset"
      />
      <div class="overview-grid" style="margin-top: 12px;">
        <div class="overview-row"><span>当前偏移</span><strong data-role="section-offset-value">${Math.round(section.offset)}</strong></div>
        <div class="overview-row"><span>范围</span><strong>${Math.round(axisBounds.min)} ~ ${Math.round(axisBounds.max)}</strong></div>
      </div>
    </div>
  `;
}

function renderMeasurePanel() {
  const { measure, selectionMode } = state.workbench;
  const latestResult = measure.result;
  const picksText = measure.picks.length
    ? measure.picks.map((pick) => getSelectionLabel(pick)).join("  ->  ")
    : "尚未采样";

  return `
    <div class="panel-card">
      <h4>测量开关</h4>
      <div class="toggle-row">
        <span>${measure.enabled ? "测量模式已启用" : "点击工具栏或此处按钮启用测量"}</span>
        <button class="secondary-button ${measure.enabled ? "is-active" : ""}" data-action="toggle-measure">
          ${measure.enabled ? "关闭" : "开启"}
        </button>
      </div>
    </div>
    <div class="panel-card">
      <h4>测量类型</h4>
      <div class="segmented">
        ${["distance", "angle", "edge"]
          .map(
            (mode) => `
              <button class="${measure.mode === mode ? "is-active" : ""}" data-action="measure-mode" data-mode="${mode}">
                ${measureModeLabel(mode)}
              </button>
            `,
          )
          .join("")}
      </div>
      <p style="margin-top: 12px;">
        ${
          measure.mode === "angle"
            ? `角度测量建议切换到面级选择。当前：${selectionMode === "face" ? "面级选择" : "零件级选择"}。`
            : "启用后，点击 viewer 中对象即可采样；结果会自动进入历史列表。"
        }
      </p>
    </div>
    <div class="panel-card">
      <h4>当前采样</h4>
      <p>${escapeHtml(picksText)}</p>
      ${latestResult ? `<div class="measure-result"><span>${escapeHtml(latestResult.label)}</span><strong>${escapeHtml(latestResult.value)}</strong></div>` : `<div class="inline-note">还没有完成一次测量。</div>`}
      <div class="control-grid" style="margin-top: 12px;">
        <button class="secondary-button" data-action="clear-measure">清空当前测量</button>
      </div>
    </div>
    <div class="panel-card">
      <h4>历史记录</h4>
      <div class="measure-history">
        ${
          measure.history.length
            ? measure.history
                .map(
                  (item) => `
                    <div class="measure-history-item">
                      <span>${escapeHtml(item.label)}</span>
                      <strong>${escapeHtml(item.value)}</strong>
                    </div>
                  `,
                )
                .join("")
            : `<div class="inline-note">暂无历史记录。</div>`
        }
      </div>
    </div>
  `;
}

function renderPropertiesPanel() {
  const selection = state.workbench.selection;
  if (!selection) {
    return `
      <div class="panel-card">
        <h4>暂无选中对象</h4>
        <p>在装配树或主视图区中选中一个零件或面后，这里会展示它的基础属性。</p>
      </div>
    `;
  }

  const node = state.activeProject.nodeMap.get(selection.nodeId);
  if (!node) {
    return "";
  }

  const face = selection.faceId ? node.faces.find((item) => item.id === selection.faceId) : null;

  return `
    <div class="panel-card">
      <h4>基础属性</h4>
      <div class="property-grid">
        <div class="property-row"><span>名称</span><strong>${escapeHtml(node.name)}</strong></div>
        <div class="property-row"><span>类型</span><strong>${selection.selectionType === "face" ? "面" : node.kind === "assembly" ? "装配" : "零件"}</strong></div>
        <div class="property-row"><span>路径</span><strong>${escapeHtml(node.pathNames.join(" / "))}</strong></div>
        <div class="property-row"><span>颜色</span><strong>${escapeHtml(node.color || "-")}</strong></div>
        <div class="property-row"><span>材料</span><strong>${escapeHtml(node.material || "-")}</strong></div>
        ${
          node.kind === "part"
            ? `
              <div class="property-row"><span>尺寸</span><strong>${formatVector(node.bbox.size)}</strong></div>
              <div class="property-row"><span>中心点</span><strong>${formatVector(node.bbox.center)}</strong></div>
              <div class="property-row"><span>拓扑面数</span><strong>${node.topology?.faceCount ?? "-"}</strong></div>
              <div class="property-row"><span>实体数</span><strong>${node.topology?.solidCount ?? "-"}</strong></div>
            `
            : ""
        }
        ${
          face
            ? `
              <div class="property-row"><span>面名称</span><strong>${escapeHtml(face.name)}</strong></div>
              <div class="property-row"><span>法向</span><strong>${formatVector(face.normal)}</strong></div>
              <div class="property-row"><span>面积</span><strong>${formatNumber(face.area)}</strong></div>
              <div class="property-row"><span>最长边</span><strong>${formatNumber(face.longestEdge)}</strong></div>
            `
            : ""
        }
      </div>
    </div>
  `;
}
function renderToasts() {
  if (!state.toasts.length) {
    return "";
  }

  return `
    <div class="toast-stack">
      ${state.toasts
        .map(
          (toast) => `
            <div class="toast toast-${toast.tone}">
              ${escapeHtml(toast.message)}
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function mountViewer(snapshot) {
  const canvas = document.getElementById("viewer-canvas");
  if (!canvas || !state.activeProject || !state.workbench) {
    destroyViewer();
    return;
  }

  destroyViewer();
  state.viewer = new WorkbenchViewer({
    canvas,
    onObjectPick: handleViewerPick,
    onHintChange: updateViewerHint,
  });
  state.viewer.setScene(state.activeProject.assembly, { preserveCamera: Boolean(snapshot) });
  if (snapshot) {
    state.viewer.restore(snapshot);
  }
  syncViewerState();
}

function syncViewerState() {
  if (!state.viewer || !state.workbench) {
    return;
  }

  state.viewer.updateState({
    selectionMode: state.workbench.selectionMode,
    hiddenNodeIds: state.workbench.hiddenNodeIds,
    isolatedNodeIds: state.workbench.isolatedNodeIds,
    nodeOpacityMap: state.workbench.nodeOpacityMap,
    nodeTranslationMap: state.workbench.nodeTranslationMap,
    faceMapTargetPartIds: state.workbench.faceMapTargetPartIds,
    displayMode: state.workbench.displayMode,
    section: state.workbench.section,
    reasoningOverlay:
      state.workbench.workspaceMode === "reasoning"
        ? state.workbench.reasoning.overlay
        : createEmptyReasoningOverlay(),
  });
  state.viewer.setSelection(state.workbench.selection);
}
function updateViewerHint(message) {
  if (!state.workbench) {
    return;
  }

  state.workbench.viewerHint = message;
  const viewerHint = document.querySelector('[data-role="viewer-hint"]');
  const statusHint = document.querySelector('[data-role="status-hint"]');
  if (viewerHint) {
    viewerHint.textContent = message;
  }
  if (statusHint) {
    statusHint.textContent = message;
  }
}

async function handleClick(event) {
  const clickedInsideProjectMenu = event.target.closest('[data-role="project-menu"]');
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    if (state.openProjectMenuId && !clickedInsideProjectMenu) {
      state.openProjectMenuId = null;
      render();
    }
    return;
  }

  const {
    action,
    projectId,
    nodeId,
    panel,
    preset,
    axis,
    mode,
    workspaceMode,
    basePartId,
    assemblingPartId,
    baseFaceId,
    assemblingFaceId,
    sequenceId,
    stepIndex,
    agentStepIndex,
  } = actionTarget.dataset;

  if (action !== "toggle-project-menu" && state.openProjectMenuId) {
    state.openProjectMenuId = null;
  }

  switch (action) {
    case "toggle-project-menu":
      state.openProjectMenuId = state.openProjectMenuId === projectId ? null : projectId;
      render();
      return;
    case "pick-step":
      await handlePickStep();
      return;
    case "open-project":
      setRoute({ page: "workbench", projectId });
      return;
    case "retry-project":
      await api.retryProject(projectId);
      pushToast("重新解析已开始。", "info");
      return;
    case "rename-project":
      await handleRenameProject(projectId);
      return;
    case "delete-project":
      await handleDeleteProject(projectId);
      return;
    case "open-source-dir":
      await api.openSourceDir(projectId);
      pushToast("已打开源文件所在目录。", "success");
      return;
    case "go-home":
      setRoute({ page: "home" });
      return;
    case "open-model-agent-panel":
      if (!state.workbench) {
        return;
      }
      state.workbench.workspaceMode = "model";
      state.workbench.activePanel = "agent";
      render();
      return;
    case "set-workspace-mode":
      if (!state.workbench) {
        return;
      }
      state.workbench.workspaceMode = workspaceMode === "reasoning" ? "reasoning" : "model";
      render();
      if (state.workbench.workspaceMode === "reasoning") {
        if (state.workbench.reasoning.status === "idle") {
          await refreshReasoningData();
        } else if (state.workbench.reasoningPanel === "transform") {
          applyReasoningOverlay(state.workbench.reasoning.data.transformOverlay);
          render();
        } else if (state.workbench.reasoningPanel === "agent") {
          if (state.workbench.reasoning.data.agentAnalysis.timeline?.length) {
            applyAgentTimelineFocus(
              state.workbench.reasoning.data.agentAnalysis.selectedTimelineIndex >= 0
                ? state.workbench.reasoning.data.agentAnalysis.selectedTimelineIndex
                : 0,
              { silent: true },
            );
          } else {
            applyReasoningOverlay(state.workbench.reasoning.data.constraintsOverlay);
          }
          render();
        } else if (state.workbench.reasoningPanel === "steps") {
          applyReasoningMatingFaceHighlight(
            state.workbench.reasoning.selection.highlightedBaseFaceId,
            state.workbench.reasoning.selection.highlightedAssemblingFaceId,
          );
          if (!state.workbench.reasoning.data.stepVisualEvidence) {
            await captureReasoningVisualEvidence({ silent: true });
          }
          render();
        } else {
          applyReasoningOverlay(state.workbench.reasoning.data.constraintsOverlay);
          render();
        }
      } else {
        applyReasoningOverlay(null);
        render();
      }
      return;
    case "refresh-reasoning":
      await refreshReasoningData();
      return;
    case "run-vlm-agent-analysis":
      await runVlmAgentAnalysis();
      return;
    case "send-agent-chat":
      await runVlmAgentAnalysis({ fromChat: true });
      return;
    case "agent-isolate-parts":
      applyAgentPartIsolation();
      return;
    case "agent-hide-parts":
      hideAgentTargetParts();
      return;
    case "agent-clear-isolation":
      clearAgentPartIsolation();
      return;
    case "reset-display-visibility":
      resetDisplayVisibilityState();
      return;
    case "agent-apply-opacity":
      applyAgentPartOpacity();
      return;
    case "agent-reset-opacity":
      resetAgentPartOpacity();
      return;
    case "agent-show-face-map":
      enableAgentFaceMap();
      return;
    case "agent-hide-face-map":
      disableAgentFaceMap();
      return;
    case "toggle-face-map-display":
      toggleFaceMapDisplay();
      return;
    case "agent-translate-parts":
      applyAgentPartTranslation();
      return;
    case "agent-reset-translation":
      resetAgentPartTranslation();
      return;
    case "viewer-fit":
      state.viewer?.fit();
      return;
    case "viewer-preset":
      state.viewer?.setViewPreset(preset);
      updateViewerHint(`切换到 ${actionTarget.textContent.trim()}`);
      return;
    case "toggle-selection-mode":
      state.workbench.selectionMode = state.workbench.selectionMode === "part" ? "face" : "part";
      clearMeasure(false);
      render();
      return;
    case "toggle-measure":
      state.workbench.measure.enabled = !state.workbench.measure.enabled;
      state.workbench.activePanel = "measure";
      render();
      return;
    case "toggle-section":
      state.workbench.section.enabled = !state.workbench.section.enabled;
      state.workbench.activePanel = "section";
      render();
      return;
    case "save-screenshot":
      await handleSaveScreenshot();
      return;
    case "set-panel":
      state.workbench.activePanel = panel;
      render();
      return;
    case "set-reasoning-panel":
      state.workbench.reasoningPanel = panel;
      if (panel === "transform") {
        applyReasoningOverlay(state.workbench.reasoning.data.transformOverlay);
        if (!state.workbench.reasoning.data.relativeTransform) {
          await loadReasoningTransform();
          return;
        }
      } else if (panel === "agent") {
        if (state.workbench.reasoning.data.agentAnalysis.timeline?.length) {
          applyAgentTimelineFocus(
            state.workbench.reasoning.data.agentAnalysis.selectedTimelineIndex >= 0
              ? state.workbench.reasoning.data.agentAnalysis.selectedTimelineIndex
              : 0,
            { silent: true },
          );
        } else {
          applyReasoningOverlay(state.workbench.reasoning.data.constraintsOverlay);
        }
      } else if (panel === "steps") {
        applyReasoningMatingFaceHighlight(
          state.workbench.reasoning.selection.highlightedBaseFaceId,
          state.workbench.reasoning.selection.highlightedAssemblingFaceId,
        );
        if (!state.workbench.reasoning.data.stepExplanation) {
          await loadReasoningStep({ capturePreview: true });
          return;
        }
        if (!state.workbench.reasoning.data.stepVisualEvidence) {
          await captureReasoningVisualEvidence({ silent: true });
        }
      } else if (panel === "constraints") {
        applyReasoningOverlay(state.workbench.reasoning.data.constraintsOverlay);
      }
      render();
      return;
    case "select-reasoning-base":
      await selectReasoningBasePart(basePartId);
      return;
    case "select-reasoning-pair":
      await selectReasoningPair(basePartId, assemblingPartId);
      return;
    case "select-reasoning-sequence":
      await selectReasoningSequence(sequenceId);
      return;
    case "select-reasoning-step":
      await selectReasoningStep(sequenceId, Number(stepIndex));
      return;
    case "highlight-reasoning-mating-face":
      applyReasoningMatingFaceHighlight(baseFaceId, assemblingFaceId);
      await captureReasoningVisualEvidence({ silent: true });
      render();
      return;
    case "refresh-reasoning-transform":
      await loadReasoningTransform();
      return;
    case "refresh-reasoning-step":
      await loadReasoningStep();
      return;
    case "select-agent-step":
      applyAgentTimelineFocus(Number(agentStepIndex || 0));
      return;
    case "toggle-node":
      toggleExpandedNode(nodeId);
      render();
      return;
    case "select-node":
      handleTreeSelection(nodeId);
      return;
    case "toggle-visibility":
      if (nodeId) {
        toggleNodeVisibility(nodeId);
        render();
      }
      return;
    case "show-all":
      state.workbench.hiddenNodeIds = new Set();
      state.workbench.isolatedNodeIds = null;
      render();
      return;
    case "isolate-selection":
      applyIsolation();
      render();
      return;
    case "clear-isolation":
      state.workbench.isolatedNodeIds = null;
      render();
      return;
    case "section-axis":
      state.workbench.section.axis = axis;
      render();
      return;
    case "measure-mode":
      state.workbench.measure.mode = mode;
      clearMeasure(false);
      render();
      return;
    case "clear-measure":
      clearMeasure(true);
      render();
      return;
    default:
      break;
  }
}
function handleInput(event) {
  const target = event.target;
  const bind = target.dataset.bind;
  if (!bind) {
    return;
  }

  if (bind === "home-search") {
    state.searchText = target.value;
    state.openProjectMenuId = null;
    updateHomeResultsSection();
    return;
  }

  if (bind === "tree-search") {
    state.workbench.treeSearch = target.value;
    render({ preserveBoundInput: true });
    return;
  }

  if (bind === "agent-part-query") {
    state.workbench.reasoning.data.agentAnalysis.partQuery = target.value;
    render({ preserveBoundInput: true });
    return;
  }

  if (bind === "agent-chat-input") {
    state.workbench.reasoning.data.agentAnalysis.chatInput = target.value;
    return;
  }

  if (bind === "agent-opacity") {
    state.workbench.reasoning.data.agentAnalysis.opacityValue = Number(target.value);
    render({ preserveBoundInput: true });
    return;
  }

  if (bind === "agent-move-direction-x") {
    state.workbench.reasoning.data.agentAnalysis.moveDirectionX = Number(target.value);
    render({ preserveBoundInput: true });
    return;
  }

  if (bind === "agent-move-direction-y") {
    state.workbench.reasoning.data.agentAnalysis.moveDirectionY = Number(target.value);
    render({ preserveBoundInput: true });
    return;
  }

  if (bind === "agent-move-direction-z") {
    state.workbench.reasoning.data.agentAnalysis.moveDirectionZ = Number(target.value);
    render({ preserveBoundInput: true });
    return;
  }

  if (bind === "agent-move-distance") {
    state.workbench.reasoning.data.agentAnalysis.moveDistance = Number(target.value);
    render({ preserveBoundInput: true });
    return;
  }

  if (bind === "section-offset") {
    state.workbench.section.offset = Number(target.value);
    const output = document.querySelector('[data-role="section-offset-value"]');
    if (output) {
      output.textContent = String(Math.round(state.workbench.section.offset));
    }
    syncViewerState();
  }
}

function handleChange(event) {
  const target = event.target;
  const bind = target.dataset.bind;
  if (!bind) {
    return;
  }

  if (bind === "home-filter") {
    state.filterStatus = target.value;
    state.openProjectMenuId = null;
    updateHomeResultsSection();
  }
}

async function handlePickStep() {
  const filePaths = await api.pickStepFiles();
  if (!filePaths.length) {
    return;
  }

  await importFiles(filePaths);
}

async function importFiles(filePaths) {
  const results = await api.importProjects(filePaths);
  let importedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;

  results.forEach((result) => {
    if (!result.ok) {
      failedCount += 1;
      pushToast(result.error, "error");
      return;
    }

    if (result.project.duplicate) {
      duplicateCount += 1;
    } else {
      importedCount += 1;
    }
  });

  state.projects = await api.listProjects();
  render();

  if (importedCount) {
    pushToast(`已创建 ${importedCount} 个项目，解析流程已开始。`, "success");
  }
  if (duplicateCount) {
    pushToast(`${duplicateCount} 个文件已存在，未重复导入。`, "warning");
  }
  if (failedCount && !importedCount) {
    pushToast("导入失败，请检查文件格式。", "error");
  }
}
async function handleRenameProject(projectId) {
  const current = state.projects.find((project) => project.projectId === projectId) || state.activeProject?.manifest;
  const nextName = window.prompt("输入新的项目名称：", current?.projectName || "");
  if (!nextName) {
    return;
  }

  await api.renameProject(projectId, nextName);
  pushToast("项目名称已更新。", "success");
}

async function handleDeleteProject(projectId) {
  const confirmed = window.confirm("删除后将移除该项目目录及缓存文件，是否继续？");
  if (!confirmed) {
    return;
  }

  await api.deleteProject(projectId);
  pushToast("项目已删除。", "success");
}

async function handleSaveScreenshot() {
  const canvas = document.getElementById("viewer-canvas");
  if (!canvas || !state.activeProject) {
    return;
  }

  const result = await api.saveScreenshot({
    projectName: state.activeProject.manifest.projectName,
    dataUrl: canvas.toDataURL("image/png"),
  });

  if (!result?.canceled) {
    pushToast("截图已导出。", "success");
  }
}

function handleViewerPick(pick) {
  const selection = enrichSelection(pick);
  if (!selection) {
    return;
  }

  state.workbench.selection = selection;
  autoRevealTree(selection.nodeId);
  if (state.workbench.measure.enabled) {
    applyMeasurement(selection);
  }
  render();
}

function handleTreeSelection(nodeId) {
  state.workbench.selection = buildSelectionFromNode(state.activeProject, nodeId);
  autoRevealTree(nodeId);
  render();
}

function enrichSelection(pick) {
  const node = state.activeProject.nodeMap.get(pick.nodeId);
  if (!node) {
    return null;
  }

  const base = {
    nodeId: node.id,
    nodeName: node.name,
    selectionType: pick.selectionType,
    pathNames: node.pathNames,
    meshId: pick.meshId || null,
    faceId: pick.faceId || null,
    point: Array.isArray(pick.point)
      ? { x: pick.point[0], y: pick.point[1], z: pick.point[2] }
      : pick.point || null,
    normal: pick.normal || null,
  };

  if (pick.faceId) {
    const face =
      state.activeProject.faceMap.get(pick.faceId) || node.faces?.find((item) => item.id === pick.faceId);
    return {
      ...base,
      faceName: face?.name || null,
      label: `${node.name} / ${face?.name || "面"}`,
    };
  }

  return {
    ...base,
    label: node.name,
  };
}

function buildSelectionFromNode(project, nodeId) {
  const node = project.nodeMap.get(nodeId);
  if (!node) {
    return null;
  }

  return {
    nodeId: node.id,
    nodeName: node.name,
    selectionType: node.kind === "part" ? "part" : "assembly",
    pathNames: node.pathNames,
    meshId: node.meshRefs?.[0] || null,
    faceId: null,
    point: node.bbox?.center || null,
    label: node.name,
  };
}

function toggleExpandedNode(nodeId) {
  if (state.workbench.expandedNodeIds.has(nodeId)) {
    state.workbench.expandedNodeIds.delete(nodeId);
  } else {
    state.workbench.expandedNodeIds.add(nodeId);
  }
}

function autoRevealTree(nodeId) {
  let current = state.activeProject.nodeMap.get(nodeId);
  while (current?.parentId) {
    state.workbench.expandedNodeIds.add(current.parentId);
    current = state.activeProject.nodeMap.get(current.parentId);
  }
}

function isNodeSubtreeHidden(nodeId) {
  const partIds = getPartIdsForNode(nodeId);
  return partIds.length > 0 && partIds.every((partId) => state.workbench.hiddenNodeIds.has(partId));
}

function toggleNodeVisibility(nodeId) {
  const partIds = getPartIdsForNode(nodeId);
  if (!partIds.length) {
    return;
  }

  const shouldHide = partIds.some((partId) => !state.workbench.hiddenNodeIds.has(partId));
  const nextHidden = new Set(state.workbench.hiddenNodeIds);
  partIds.forEach((partId) => {
    if (shouldHide) {
      nextHidden.add(partId);
    } else {
      nextHidden.delete(partId);
    }
  });

  state.workbench.hiddenNodeIds = nextHidden;
  if (state.workbench.selection && partIds.includes(state.workbench.selection.nodeId) && shouldHide) {
    state.workbench.selection = null;
  }
}

function applyIsolation() {
  if (!state.workbench.selection) {
    pushToast("请先选中一个对象，再执行隔离。", "warning");
    return;
  }

  const partIds = getPartIdsForNode(state.workbench.selection.nodeId);
  state.workbench.isolatedNodeIds = new Set(partIds);
  state.workbench.activePanel = "display";
}

function clearMeasure(withToast) {
  state.workbench.measure.picks = [];
  state.workbench.measure.result = null;
  if (withToast) {
    pushToast("已清空当前测量采样。", "info");
  }
}

function applyMeasurement(selection) {
  const measure = state.workbench.measure;
  if (measure.mode === "edge") {
    measure.picks = [selection];
    const result = computeEdgeMeasurement(selection);
    if (result) {
      measure.result = result;
      measure.history = [result, ...measure.history].slice(0, 6);
    }
    return;
  }

  measure.picks = [...measure.picks, selection].slice(-2);

  if (measure.mode === "distance" && measure.picks.length === 2) {
    const result = computeDistanceMeasurement(measure.picks[0], measure.picks[1]);
    if (result) {
      measure.result = result;
      measure.history = [result, ...measure.history].slice(0, 6);
      measure.picks = [];
    }
    return;
  }

  if (measure.mode === "angle" && measure.picks.length === 2) {
    const result = computeAngleMeasurement(measure.picks[0], measure.picks[1]);
    if (result) {
      measure.result = result;
      measure.history = [result, ...measure.history].slice(0, 6);
      measure.picks = [];
    }
  }
}

function computeDistanceMeasurement(leftSelection, rightSelection) {
  const leftPoint = getSelectionAnchor(leftSelection);
  const rightPoint = getSelectionAnchor(rightSelection);
  if (!leftPoint || !rightPoint) {
    return null;
  }

  const dx = rightPoint.x - leftPoint.x;
  const dy = rightPoint.y - leftPoint.y;
  const dz = rightPoint.z - leftPoint.z;
  const distance = Math.sqrt(dx ** 2 + dy ** 2 + dz ** 2);

  return {
    label: `距离：${getSelectionLabel(leftSelection)} -> ${getSelectionLabel(rightSelection)}`,
    value: `${formatNumber(distance)} mm`,
  };
}

function computeAngleMeasurement(leftSelection, rightSelection) {
  const leftFace = getSelectionFace(leftSelection);
  const rightFace = getSelectionFace(rightSelection);
  if (!leftFace || !rightFace) {
    pushToast("角度测量需要在面级选择模式下选中两个面。", "warning");
    return null;
  }

  const leftLength = vectorLength(leftFace.normal);
  const rightLength = vectorLength(rightFace.normal);
  const dot =
    leftFace.normal.x * rightFace.normal.x +
    leftFace.normal.y * rightFace.normal.y +
    leftFace.normal.z * rightFace.normal.z;
  const radians = Math.acos(clamp(dot / (leftLength * rightLength), -1, 1));
  const degrees = (radians * 180) / Math.PI;

  return {
    label: `角度：${getSelectionLabel(leftSelection)} -> ${getSelectionLabel(rightSelection)}`,
    value: `${formatNumber(degrees)}°`,
  };
}

function computeEdgeMeasurement(selection) {
  const node = state.activeProject.nodeMap.get(selection.nodeId);
  if (!node || node.kind !== "part") {
    return null;
  }

  if (selection.faceId) {
    const face = node.faces.find((item) => item.id === selection.faceId);
    return face
      ? {
          label: `最长边：${getSelectionLabel(selection)}`,
          value: `${formatNumber(face.longestEdge)} mm`,
        }
      : null;
  }

  return {
    label: `特征尺寸：${getSelectionLabel(selection)}`,
    value: `${formatNumber(maxDimension(node.bbox.size))} mm`,
  };
}
function getSelectionAnchor(selection) {
  if (selection?.point) {
    return selection.point;
  }

  const node = state.activeProject.nodeMap.get(selection.nodeId);
  if (!node || node.kind !== "part") {
    return null;
  }

  if (!selection.faceId) {
    return node.bbox.center;
  }

  const face = node.faces.find((item) => item.id === selection.faceId);
  if (!face) {
    return node.bbox.center;
  }

  return {
    x: node.bbox.center.x + face.normal.x * (node.bbox.size.x / 2),
    y: node.bbox.center.y + face.normal.y * (node.bbox.size.y / 2),
    z: node.bbox.center.z + face.normal.z * (node.bbox.size.z / 2),
  };
}

function getSelectionFace(selection) {
  if (!selection?.faceId) {
    return null;
  }

  return state.activeProject.faceMap.get(selection.faceId) || null;
}

function vectorLength(vector) {
  return Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2);
}

function getPartIdsForNode(nodeId) {
  const startNode = state.activeProject.nodeMap.get(nodeId);
  if (!startNode) {
    return [];
  }

  if (startNode.kind === "part") {
    return [startNode.id];
  }

  const result = [];
  const stack = [startNode];
  while (stack.length) {
    const current = stack.pop();
    current.children.forEach((childId) => {
      const child = state.activeProject.nodeMap.get(childId);
      if (!child) {
        return;
      }
      if (child.kind === "part") {
        result.push(child.id);
      } else {
        stack.push(child);
      }
    });
  }
  return result;
}

function getFilteredProjects() {
  const search = state.searchText.trim().toLowerCase();
  return state.projects.filter((project) => {
    const matchesSearch =
      !search ||
      project.projectName.toLowerCase().includes(search) ||
      project.sourceFileName.toLowerCase().includes(search);
    const matchesStatus = state.filterStatus === "all" || project.status === state.filterStatus;
    return matchesSearch && matchesStatus;
  });
}

function getVisiblePartCount() {
  if (!state.workbench || !state.activeProject) {
    return 0;
  }

  return state.activeProject.partNodes.filter((node) => {
    if (state.workbench.hiddenNodeIds.has(node.id)) {
      return false;
    }
    if (state.workbench.isolatedNodeIds && !state.workbench.isolatedNodeIds.has(node.id)) {
      return false;
    }
    return true;
  }).length;
}

function getSelectionLabel(selection = state.workbench?.selection) {
  if (!selection) {
    return "未选择";
  }

  return selection.label || selection.nodeName || "未选择";
}

function measureModeLabel(mode) {
  return {
    distance: "距离",
    angle: "角度",
    edge: "边长",
  }[mode];
}
function formatConfidence(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function formatQuaternion(quaternion) {
  if (!quaternion) {
    return "-";
  }
  return `${formatNumber(quaternion.x)} / ${formatNumber(quaternion.y)} / ${formatNumber(quaternion.z)} / ${formatNumber(quaternion.w)}`;
}
function formatBytes(value) {
  if (!value && value !== 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatNumber(value) {
  return Number(value).toFixed(1).replace(/\.0$/, "");
}

function formatVector(vector) {
  return `${formatNumber(vector.x)} / ${formatNumber(vector.y)} / ${formatNumber(vector.z)}`;
}

function maxDimension(size) {
  return Math.max(size.x || 0, size.y || 0, size.z || 0);
}

function getAxisBounds(axis, bounds) {
  return {
    min: bounds.min?.[axis] ?? -100,
    max: bounds.max?.[axis] ?? 100,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pushToast(message, tone = "info") {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  state.toasts = [...state.toasts, { id, message, tone }].slice(-4);
  render();
  window.setTimeout(() => {
    state.toasts = state.toasts.filter((toast) => toast.id !== id);
    render();
  }, 2600);
}

async function handleProjectUpdate(payload) {
  if (payload?.deleted) {
    state.projects = state.projects.filter((project) => project.projectId !== payload.projectId);
    if (state.openProjectMenuId === payload.projectId) {
      state.openProjectMenuId = null;
    }
    if (state.activeProject?.manifest.projectId === payload.projectId) {
      setRoute({ page: "home" });
      return;
    }
    render({ preserveBoundInput: state.route.page === "home" });
    return;
  }

  if (!payload?.projectId) {
    state.projects = await api.listProjects();
    render({ preserveBoundInput: state.route.page === "home" });
    return;
  }

  const nextProjects = [...state.projects];
  const index = nextProjects.findIndex((project) => project.projectId === payload.projectId);
  if (index >= 0) {
    nextProjects[index] = {
      ...nextProjects[index],
      ...payload,
    };
  } else {
    nextProjects.unshift(payload);
  }

  // Preserve the current visual order during live parsing updates so cards do not jump around.
  state.projects = nextProjects;

  if (state.activeProject?.manifest.projectId === payload.projectId) {
    const nextDetails = await api.getProjectDetails(payload.projectId);
    if (nextDetails?.manifest) {
      state.activeProject = hydrateProject(nextDetails);
      state.workbench = createWorkbenchState(state.activeProject, state.workbench);
    }
  }

  render({ preserveBoundInput: state.route.page === "home" });
}

function normalizeProgress(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(numericValue)));
}

function toggleDragMask(show) {
  dragMask.classList.toggle("hidden", !show);
}

function handleWindowDragOver(event) {
  if (!event.dataTransfer?.types?.includes("Files")) {
    return;
  }

  event.preventDefault();
  state.globalDragging = true;
  toggleDragMask(true);
}

function handleWindowDragLeave(event) {
  if (event.relatedTarget) {
    return;
  }

  state.globalDragging = false;
  toggleDragMask(false);
}

async function handleWindowDrop(event) {
  if (!event.dataTransfer?.files?.length) {
    return;
  }

  event.preventDefault();
  state.globalDragging = false;
  toggleDragMask(false);

  const filePaths = Array.from(event.dataTransfer.files)
    .map((file) => file.path)
    .filter(Boolean);

  if (filePaths.length) {
    await importFiles(filePaths);
  }
}



















































