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
    constraintsOverlay: previousData?.constraintsOverlay || createEmptyReasoningOverlay(),
    transformOverlay: previousData?.transformOverlay || createEmptyReasoningOverlay(),
    stepOverlay: previousData?.stepOverlay || createEmptyReasoningOverlay(),
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
function registerMcpBridge() {
  if (!api?.registerMcpCaptureHandler) {
    return;
  }

  api.registerMcpCaptureHandler(async (payload) => {
    if (state.route.page !== "workbench" || !state.viewer || !state.activeProject) {
      throw new Error("当前没有活动工作台，无法截图。");
    }

    const mode = payload?.mode === "id-mask" ? "id-mask" : "beauty";
    const capture = await state.viewer.capture(mode, {
      width: payload?.width,
      height: payload?.height,
      fit: payload?.fit,
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
        camera: state.viewer?.snapshot?.() || null,
        colorMaps: {
          display: state.viewer?.getColorMap?.("display") || [],
          "id-mask": state.viewer?.getColorMap?.("id-mask") || [],
        },
      }
    : {
        route: state.route.page,
        currentProjectId: null,
        selection: null,
        section: null,
        isolation: [],
        camera: null,
        colorMaps: {
          display: [],
          "id-mask": [],
        },
      };
}

function publishMcpState() {
  if (!api?.publishMcpState) {
    return;
  }

  api.publishMcpState(buildMcpStatePayload());
}

async function executeMcpCommand(payload) {
  if (state.route.page !== "workbench" || !state.activeProject || !state.workbench) {
    throw new Error("当前没有活动工作台，无法执行 MCP 交互命令。");
  }

  if (payload.projectId && payload.projectId !== state.activeProject.manifest.projectId) {
    throw new Error("当前工作台中的项目与目标 projectId 不一致。");
  }

  const action = payload.action;
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
    reasoningPanel: previousForSameProject?.reasoningPanel || "summary",
    selectionMode: previousForSameProject?.selectionMode || "part",
    selection: defaultSelection,
    expandedNodeIds: previousForSameProject?.expandedNodeIds || new Set(topLevelAssemblies),
    treeSearch: previousForSameProject?.treeSearch || "",
    hiddenNodeIds: previousForSameProject?.hiddenNodeIds || new Set(),
    isolatedNodeIds: previousForSameProject?.isolatedNodeIds || null,
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
async function refreshReasoningData() {
  if (!state.activeProject || !state.workbench) {
    return;
  }

  const reasoning = state.workbench.reasoning;
  const projectId = state.activeProject.manifest.projectId;
  reasoning.status = "loading";
  reasoning.error = "";
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

function render(options = {}) {
  const boundInputState = options.preserveBoundInput ? captureBoundInputState() : null;
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
  const selectedLabel = getSelectionLabel();
  const visiblePartCount = getVisiblePartCount();
  const hiddenPartCount = state.activeProject.partNodes.length - visiblePartCount;
  const activePanelMeta = getActivePanelMeta();
  const navigation = isReasoningMode ? REASONING_PANEL_META : PANEL_META;
  const currentStep = reasoning.data.stepExplanation;
  const focusBaseName = getPartDisplayName(reasoning.selection.basePartId);
  const focusAssemblingName = getPartDisplayName(reasoning.selection.assemblingPartId);

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
        <nav class="nav-rail">
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
          <div class="side-panel-scroll">
            ${renderWorkbenchPanel()}
          </div>
        </aside>

        <section class="viewer-shell">
          <div class="viewer-grid"></div>
          <canvas id="viewer-canvas" class="viewer-canvas"></canvas>
          <div class="viewer-overlay-top">
            <div class="viewer-chip"><strong>工作区</strong><span>${isReasoningMode ? "装配推理" : "模型工作台"}</span></div>
            <div class="viewer-chip"><strong>选择模式</strong><span>${state.workbench.selectionMode === "face" ? "面级" : "零件级"}</span></div>
            <div class="viewer-chip"><strong>${isReasoningMode ? "推理状态" : "当前剖切"}</strong><span>${isReasoningMode ? getReasoningStatusLabel(reasoning.status) : state.workbench.section.enabled ? `${state.workbench.section.axis.toUpperCase()} = ${Math.round(state.workbench.section.offset)}` : "关闭"}</span></div>
          </div>
          <div class="viewer-floating ${isReasoningMode ? "is-visible" : ""}">
            <div class="floating-card">
              <h4>${isReasoningMode ? "推理焦点" : "当前选中"}</h4>
              <p>${isReasoningMode ? `${escapeHtml(focusBaseName)} -> ${escapeHtml(focusAssemblingName)}` : escapeHtml(selectedLabel)}</p>
            </div>
            <div class="floating-card">
              <h4>${isReasoningMode ? "当前步骤" : "显示摘要"}</h4>
              <p>${isReasoningMode ? currentStep ? `${escapeHtml(currentStep.sequenceId)} / Step ${currentStep.stepIndex}` : "选择候选或步骤后联动 viewer" : `可见零件 ${visiblePartCount} / ${state.activeProject.partNodes.length}，隐藏 ${hiddenPartCount}`}</p>
            </div>
          </div>
          <div class="viewer-overlay-bottom">
            <div class="viewer-chip"><strong>操作提示</strong><span data-role="viewer-hint">${escapeHtml(state.workbench.viewerHint)}</span></div>
            <div class="viewer-chip"><strong>${isReasoningMode ? "当前聚焦" : "对象状态"}</strong><span>${isReasoningMode ? `${escapeHtml(focusBaseName)} / ${escapeHtml(focusAssemblingName)}` : state.workbench.isolatedNodeIds ? "隔离中" : "显示全部 / 自定义显隐"}</span></div>
          </div>
        </section>
      </section>

      <footer class="statusbar">
        <div class="status-items">
          <span>项目：<strong>${escapeHtml(manifest.projectName)}</strong></span>
          <span>工作区：<strong>${isReasoningMode ? "装配推理" : "模型工作台"}</strong></span>
          <span>选中对象：<strong>${escapeHtml(selectedLabel)}</strong></span>
          <span>零件 / 面数：<strong>${manifest.partCount} / ${manifest.faceCount}</strong></span>
          ${isReasoningMode ? `<span>当前步骤：<strong>${currentStep ? `${escapeHtml(currentStep.sequenceId)} / Step ${currentStep.stepIndex}` : "未选中"}</strong></span>` : ""}
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
  const selection = state.workbench.selection;
  const selectedLabel = selection ? getSelectionLabel() : "尚未选中对象";
  return `
    <div class="panel-card">
      <h4>当前可见状态</h4>
      <div class="overview-grid">
        <div class="overview-row"><span>可见零件</span><strong>${getVisiblePartCount()}</strong></div>
        <div class="overview-row"><span>隐藏零件</span><strong>${state.activeProject.partNodes.length - getVisiblePartCount()}</strong></div>
        <div class="overview-row"><span>隔离状态</span><strong>${state.workbench.isolatedNodeIds ? "已启用" : "未启用"}</strong></div>
      </div>
    </div>
    <div class="panel-card">
      <h4>显示操作</h4>
      <p>当前目标：${escapeHtml(selectedLabel)}</p>
      <div class="control-grid">
        <button class="secondary-button" data-action="show-all">显示全部</button>
        <button class="secondary-button" data-action="toggle-visibility" data-node-id="${selection?.nodeId || ""}" ${selection ? "" : "disabled"}>切换选中显隐</button>
        <button class="secondary-button" data-action="isolate-selection" ${selection ? "" : "disabled"}>隔离选中对象</button>
        <button class="secondary-button" data-action="clear-isolation" ${state.workbench.isolatedNodeIds ? "" : "disabled"}>取消隔离</button>
      </div>
    </div>
    <div class="panel-card">
      <h4>说明</h4>
      <p>当前工作台通过显隐和隔离聚焦装配局部区域，后续可以继续映射到更真实的 CAD 内核显示控制。</p>
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
    sequenceId,
    stepIndex,
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
        } else if (state.workbench.reasoningPanel === "steps") {
          applyReasoningMatingFaceHighlight(
            state.workbench.reasoning.selection.highlightedBaseFaceId,
            state.workbench.reasoning.selection.highlightedAssemblingFaceId,
          );
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
      } else if (panel === "steps") {
        applyReasoningMatingFaceHighlight(
          state.workbench.reasoning.selection.highlightedBaseFaceId,
          state.workbench.reasoning.selection.highlightedAssemblingFaceId,
        );
        if (!state.workbench.reasoning.data.stepExplanation) {
          await loadReasoningStep({ capturePreview: true });
          return;
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
      render();
      return;
    case "refresh-reasoning-transform":
      await loadReasoningTransform();
      return;
    case "refresh-reasoning-step":
      await loadReasoningStep();
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














































