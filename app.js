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
    icon: "概",
    title: "项目概览",
    description: "从项目级信息切入，确认模型来源、统计摘要和缓存状态。",
  },
  assembly: {
    icon: "树",
    title: "装配树",
    description: "搜索零件、展开层级，并与 3D 主视图区保持联动高亮。",
  },
  display: {
    icon: "显",
    title: "显示控制",
    description: "控制对象显隐与隔离范围，便于聚焦复杂装配中的局部区域。",
  },
  section: {
    icon: "剖",
    title: "剖切分析",
    description: "使用单平面剖切观察内部结构，首版支持按轴向调整位置。",
  },
  measure: {
    icon: "量",
    title: "测量工具",
    description: "在零件级与面级之间切换，完成距离、角度与边长的基础测量。",
  },
  properties: {
    icon: "属",
    title: "属性信息",
    description: "查看当前选中对象的名称、路径、材料、尺寸与面信息摘要。",
  },
};

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
  viz: null,
  toasts: [],
  globalDragging: false,
};

// 用于 TCP Bridge 的视图状态
const viewerState = {
  currentProjectId: null,
  currentRoute: null,
};

if (!api) {
  root.innerHTML = `
    <div class="loading-state">
      <div class="loading-card glass-panel">
        <h2>请通过 Electron 启动这个项目</h2>
        <p>当前页面依赖 preload 暴露的桌面能力，包括文件选择、本地缓存目录读写和截图导出。</p>
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

  // TCP Bridge: Listen for invoke requests from Python
  window.viewerApi?.onViewerInvoke(handleViewerInvoke);

  // TCP Bridge: Listen for navigation requests from Python
  window.viewerApi?.onNavigate(({ projectId, route }) => {
    // 更新 viewerState
    viewerState.currentProjectId = projectId;
    viewerState.currentRoute = route;
    // 设置 hash 让 app 处理
    const newHash = route === "workbench" ? `#/workbench/${projectId}` : `#/viz/${projectId}`;
    window.location.hash = newHash;
    // 直接调用 handleHashChange 确保路由被处理
    handleHashChange();
  });

  root.addEventListener("click", handleClick);
  root.addEventListener("input", handleInput);
  root.addEventListener("change", handleChange);
  window.addEventListener("hashchange", handleHashChange);
  window.addEventListener("dragover", handleWindowDragOver);
  window.addEventListener("dragleave", handleWindowDragLeave);
  window.addEventListener("drop", handleWindowDrop);
  window.addEventListener("beforeunload", () => state.viewer?.destroy());

  await syncRoute();
}

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("/workbench/")) {
    const projectId = hash.split("/")[2];
    return { page: "workbench", projectId };
  }
  if (hash.startsWith("/viz/")) {
    const projectId = hash.split("/")[2];
    return { page: "viz", projectId };
  }

  return { page: "home", projectId: null };
}

function setRoute(nextRoute) {
  if (nextRoute.page === "workbench" && nextRoute.projectId) {
    window.location.hash = `#/workbench/${nextRoute.projectId}`;
    return;
  }
  if (nextRoute.page === "viz" && nextRoute.projectId) {
    window.location.hash = `#/viz/${nextRoute.projectId}`;
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
  } else if (state.route.page === "viz" && state.route.projectId) {
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
  if (state.route.page === "workbench") {
    state.workbench = createWorkbenchState(state.activeProject, state.workbench);
    state.viz = null;
  } else if (state.route.page === "viz") {
    state.viz = createVizState(state.activeProject, state.viz);
    state.workbench = null;
  }
  state.loadingProjectId = null;

  // 同步 viewerState 到 TCP bridge
  await api.syncViewerState(projectId, state.route.page);

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

  // 重建 node.faces 引用，使用 faceMap 中的引用而非拷贝
  // 这样当 mesh.brepFaces 被修改时（如设置 renderColor），node.faces 也能看到变化
  assembly.nodes.forEach((node) => {
    if (node.faces && Array.isArray(node.faces)) {
      node.faces = node.faces
        .map((face) => faceMap.get(face.id))
        .filter(Boolean);
    }
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
    activePanel: previousForSameProject?.activePanel || "assembly",
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
    viewerHint: previousForSameProject?.viewerHint || "拖拽旋转，Shift + 拖拽平移，滚轮缩放",
  };
}

function createVizState(project, previousState) {
  const previousForSameProject =
    previousState && previousState.projectId === project.manifest.projectId ? previousState : null;
  return {
    projectId: project.manifest.projectId,
    activePanel: previousForSameProject?.activePanel || "display",
    selectedPartIds: previousForSameProject?.selectedPartIds || new Set(),
    hiddenNodeIds: previousForSameProject?.hiddenNodeIds || new Set(),
    isolatedNodeIds: previousForSameProject?.isolatedNodeIds || null,
    section: previousForSameProject?.section || {
      enabled: false,
      axis: "x",
      offset: 0,
    },
    cameraParams: previousForSameProject?.cameraParams || {
      azimuth: 45,
      elevation: 30,
      distance: 200,
      roll: 0,
    },
    colorMode: previousForSameProject?.colorMode || "face", // "face" 或 "part"
    viewerHint: previousForSameProject?.viewerHint || "拖拽旋转，滚轮缩放",
  };
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
  const vizSnapshot = state.route.page === "viz" ? state.viewer?.snapshot() || null : null;
  document.body.classList.toggle("workbench-mode", state.route.page === "workbench" || state.route.page === "viz");
  if (state.route.page === "workbench") {
    root.innerHTML = `${renderWorkbenchPage()}${renderToasts()}`;
    mountViewer(viewerSnapshot);
  } else if (state.route.page === "viz") {
    root.innerHTML = `${renderVizPage()}${renderToasts()}`;
    mountVizViewer(vizSnapshot);
  } else {
    root.innerHTML = `${renderHomePageWireframe()}${renderToasts()}`;
    destroyViewer();
  }

  if (boundInputState) {
    restoreBoundInputState(boundInputState);
  }

  toggleDragMask(state.globalDragging);
}

function renderHomePageWireframe() {
  const filteredProjects = getFilteredProjects();
  const readyCount = state.projects.filter((project) => project.status === "ready").length;
  const parsingCount = state.projects.filter((project) => project.status === "parsing").length;
  const failedCount = state.projects.filter((project) => project.status === "failed").length;

  return `
    <main class="page home-page">
      <section class="topbar glass-panel home-topbar">
        <div class="brand-lockup">
          <div class="brand-mark"></div>
          <div class="brand-text">
            <h1>STEP Workbench MVP</h1>
            <p>首页聚焦 STEP 导入和项目卡片浏览，保持和线框图一致的结构节奏。</p>
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
          <h2>拖拽文件到此处，或点击按钮选择本地 STEP 模型</h2>
          <p>支持 .step / .stp，导入后会自动创建项目卡片并进入解析流程。</p>
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
  const meta =
    {
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
                    ${
                      clickable
                        ? `<button class="project-menu-item" type="button" data-action="open-project" data-project-id="${project.projectId}">打开工作台</button>
                           <button class="project-menu-item" type="button" data-action="open-viz" data-project-id="${project.projectId}">零件可视化</button>`
                        : ""
                    }
                    ${
                      project.status === "failed"
                        ? `<button class="project-menu-item" type="button" data-action="retry-project" data-project-id="${project.projectId}">重新解析</button>`
                        : ""
                    }
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
            <span>装配数: <strong>${project.assemblyCount || "-"}</strong></span>
            <span>零件数: <strong>${project.partCount || "-"}</strong></span>
            <span>大小: <strong>${formatBytes(project.sourceFileSize)}</strong></span>
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
                : `<div class="project-updated-time">更新时间: ${formatDateTime(project.updatedAt)}</div>`
          }
        </div>
      </div>
    </article>
  `;
}

function renderHomePage() {
  const filteredProjects = getFilteredProjects();
  const readyCount = state.projects.filter((project) => project.status === "ready").length;
  const parsingCount = state.projects.filter((project) => project.status === "parsing").length;
  const failedCount = state.projects.filter((project) => project.status === "failed").length;

  return `
    <main class="page home-page">
      <section class="topbar glass-panel">
        <div class="brand-lockup">
          <div class="brand-mark"></div>
          <div class="brand-text">
            <h1>STEP Workbench MVP</h1>
            <p>围绕 STEP 装配模型导入、解析、缓存与可视化工作台的首版桌面实现。</p>
          </div>
        </div>
        <div class="home-actions">
          <input
            type="search"
            placeholder="搜索项目名 / 文件名"
            value="${escapeHtml(state.searchText)}"
            data-bind="home-search"
          />
          <select data-bind="home-filter">
            ${renderStatusOptions(state.filterStatus)}
          </select>
          <button class="primary-button" data-action="pick-step">
            <span>导入 STEP</span>
          </button>
        </div>
      </section>

      <section class="hero">
        <div class="hero-copy glass-panel">
          <span class="eyebrow">MVP Main Flow</span>
          <h2>从导入文件到进入工作台，先把首版闭环跑通。</h2>
          <p>
            当前实现贴合产品手册，把模型中心页、项目缓存目录、解析进度状态机、工作台基础操作和可交互 viewer
            一次性打通。真实 STEP / BRep 内核后续可以直接替换目前的模拟 Sidecar。
          </p>
          <div class="stats-strip">
            <div class="stat-card">
              <strong>${state.projects.length}</strong>
              <span>项目总数</span>
            </div>
            <div class="stat-card">
              <strong>${readyCount}</strong>
              <span>可打开项目</span>
            </div>
            <div class="stat-card">
              <strong>${parsingCount + failedCount}</strong>
              <span>处理中 / 异常</span>
            </div>
          </div>
        </div>
        <div class="hero-side glass-panel">
          <h3>首版已落地的关键能力</h3>
          <p>主页强调导入与卡片浏览，工作台强调 3D 主视图和装配树联动，和手册目标保持同一个节奏。</p>
          <div class="feature-list">
            <div class="feature-item">
              <strong>本地缓存结构</strong>
              <span>自动生成 \`manifest.json\`、\`assembly.json\`、\`source.step\`、\`thumbnail.svg\`。</span>
            </div>
            <div class="feature-item">
              <strong>解析状态机</strong>
              <span>从待处理到解析中再到可打开，支持失败重试与实时进度反馈。</span>
            </div>
            <div class="feature-item">
              <strong>工作台交互</strong>
              <span>支持装配树、选择模式、显示控制、基础测量、单平面剖切与截图导出。</span>
            </div>
          </div>
        </div>
      </section>

      <section class="section-head">
        <div class="section-title">
          <h3>导入与模型中心</h3>
          <p>上传区和项目卡片列表会共同承担首版的主入口任务。</p>
        </div>
      </section>

      <section class="upload-zone ${state.globalDragging ? "is-dragging" : ""}" data-action="pick-step">
        <div class="upload-zone-top">
          <div class="upload-zone-copy">
            <h3>拖拽 STEP 文件到这里，或点击进入文件选择器</h3>
            <p>支持 \`.step / .stp\`。导入后会立刻创建项目目录，并进入模拟解析流水线，方便前后端接口先对齐。</p>
          </div>
          <button class="primary-button" data-action="pick-step">上传 STEP</button>
        </div>
        <div class="upload-hint-row">
          <span class="hint-pill">一项目一目录</span>
          <span class="hint-pill">解析状态实时反馈</span>
          <span class="hint-pill">失败可重试</span>
          <span class="hint-pill">缩略图自动生成</span>
        </div>
      </section>

      <section class="section-head">
        <div class="section-title">
          <h3>项目卡片</h3>
          <p>共 ${filteredProjects.length} 个结果，按最近更新时间排序。</p>
        </div>
      </section>

      ${
        filteredProjects.length
          ? `<section class="project-grid">${filteredProjects.map((project) => renderProjectCard(project)).join("")}</section>`
          : `
            <section class="empty-state glass-panel">
              <h3>还没有匹配的项目</h3>
              <p>
                可以先导入一个 STEP 文件来生成首个项目；如果你已经导入过内容，也可以调整搜索词或筛选条件重新查看。
              </p>
            </section>
          `
      }
    </main>
  `;
}

function renderStatusOptions(selected) {
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

function renderProjectCard(project) {
  const meta = STATUS_META[project.status] || STATUS_META.pending;
  const clickable = project.status === "ready";
  return `
    <article class="project-card ${clickable ? "is-clickable" : ""}" data-project-id="${project.projectId}">
      <div class="thumbnail-frame ${project.thumbnailDataUrl ? "" : "is-empty"}" ${
        clickable ? `data-action="open-project" data-project-id="${project.projectId}"` : ""
      }>
        ${project.thumbnailDataUrl ? `<img alt="${escapeHtml(project.projectName)}" src="${project.thumbnailDataUrl}" />` : ""}
      </div>
      <div class="project-card-top">
        <div class="project-meta">
          <h4>${escapeHtml(project.projectName)}</h4>
          <p>${escapeHtml(project.sourceFileName)}</p>
        </div>
        <span class="status-pill ${meta.className}">${meta.label}${project.status === "parsing" ? ` ${project.progress || 0}%` : ""}</span>
      </div>
      <div class="project-facts">
        <div class="fact-card">
          <strong>装配数</strong>
          <span>${project.assemblyCount || "-"}</span>
        </div>
        <div class="fact-card">
          <strong>零件数</strong>
          <span>${project.partCount || "-"}</span>
        </div>
        <div class="fact-card">
          <strong>文件大小</strong>
          <span>${formatBytes(project.sourceFileSize)}</span>
        </div>
      </div>
      ${
        project.status === "parsing"
          ? `
            <div class="progress-block">
              <div class="progress-copy">
                <span>${escapeHtml(project.currentStage || "解析中")}</span>
                <strong>${project.progress || 0}%</strong>
              </div>
              <div class="progress-track">
                <div class="progress-value" style="width: ${project.progress || 0}%"></div>
              </div>
            </div>
          `
          : project.status === "failed"
            ? `<div class="error-box">${escapeHtml(project.errorSummary || "解析失败，请重试。")}</div>`
            : `<div class="inline-note">更新时间：${formatDateTime(project.updatedAt)}</div>`
      }
      <div class="project-actions">
        ${
          clickable
            ? `<button class="secondary-button" data-action="open-project" data-project-id="${project.projectId}">打开工作台</button>`
            : ""
        }
        ${
          project.status === "failed"
            ? `<button class="secondary-button" data-action="retry-project" data-project-id="${project.projectId}">重新解析</button>`
            : ""
        }
        <button class="ghost-button" data-action="rename-project" data-project-id="${project.projectId}">重命名</button>
        <button class="ghost-button" data-action="open-source-dir" data-project-id="${project.projectId}">源目录</button>
        <button class="ghost-button" data-action="delete-project" data-project-id="${project.projectId}">删除</button>
      </div>
    </article>
  `;
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
  const selectedLabel = getSelectionLabel();
  const visiblePartCount = getVisiblePartCount();
  const hiddenPartCount = state.activeProject.partNodes.length - visiblePartCount;
  const activePanelMeta = PANEL_META[state.workbench.activePanel];

  return `
    <main class="workbench-shell">
      <header class="workbench-toolbar">
        <div class="toolbar-cluster">
          <button class="secondary-button" data-action="go-home">返回首页</button>
          <div class="toolbar-title">
            <strong>${escapeHtml(manifest.projectName)}</strong>
            <span>${escapeHtml(manifest.sourceFileName)}</span>
          </div>
        </div>
        <div class="toolbar-cluster">
          <button class="toolbar-button" data-action="viewer-fit">适配</button>
          ${["front", "left", "top", "right", "back", "bottom"].map((preset) => renderPresetButton(preset)).join("")}
          <button class="toolbar-button ${state.workbench.selectionMode === "face" ? "is-active" : ""}" data-action="toggle-selection-mode">
            ${state.workbench.selectionMode === "face" ? "面级选择" : "零件选择"}
          </button>
          <button class="toolbar-button ${state.workbench.isolatedNodeIds ? "is-active" : ""}" data-action="isolate-selection">隔离</button>
          <button class="toolbar-button ${state.workbench.measure.enabled ? "is-active" : ""}" data-action="toggle-measure">测量</button>
          <button class="toolbar-button ${state.workbench.section.enabled ? "is-active" : ""}" data-action="toggle-section">剖切</button>
          <button class="toolbar-button" data-action="save-screenshot">截图</button>
        </div>
      </header>

      <section class="workbench-body">
        <nav class="nav-rail">
          ${Object.entries(PANEL_META)
            .map(([key, panel]) => {
              const isActive = key === state.workbench.activePanel;
              return `
                <button class="nav-button ${isActive ? "is-active" : ""}" data-action="set-panel" data-panel="${key}">
                  <strong>${panel.icon}</strong>
                  <span>${panel.title}</span>
                </button>
              `;
            })
            .join("")}
        </nav>

        <aside class="side-panel">
          <div class="side-panel-header">
            <h3>${activePanelMeta.title}</h3>
            <p>${activePanelMeta.description}</p>
          </div>
          <div class="side-panel-scroll">
            ${renderWorkbenchPanel()}
          </div>
        </aside>

        <section class="viewer-shell">
          <div class="viewer-grid"></div>
          <canvas id="viewer-canvas" class="viewer-canvas"></canvas>
          <div class="viewer-overlay-top">
            <div class="viewer-chip"><strong>选择模式</strong><span>${state.workbench.selectionMode === "face" ? "面级" : "零件级"}</span></div>
            <div class="viewer-chip"><strong>当前剖切</strong><span>${state.workbench.section.enabled ? `${state.workbench.section.axis.toUpperCase()} = ${Math.round(state.workbench.section.offset)}` : "关闭"}</span></div>
          </div>
          <div class="viewer-floating">
            <div class="floating-card">
              <h4>当前选中</h4>
              <p>${escapeHtml(selectedLabel)}</p>
            </div>
            <div class="floating-card">
              <h4>显示摘要</h4>
              <p>可见零件 ${visiblePartCount} / ${state.activeProject.partNodes.length}，隐藏 ${hiddenPartCount}。</p>
            </div>
          </div>
          <div class="viewer-overlay-bottom">
            <div class="viewer-chip"><strong>操作提示</strong><span data-role="viewer-hint">${escapeHtml(state.workbench.viewerHint)}</span></div>
            <div class="viewer-chip"><strong>对象状态</strong><span>${state.workbench.isolatedNodeIds ? "隔离中" : "显示全部 / 自定义显隐"}</span></div>
          </div>
        </section>
      </section>

      <footer class="statusbar">
        <div class="status-items">
          <span>项目：<strong>${escapeHtml(manifest.projectName)}</strong></span>
          <span>选中对象：<strong>${escapeHtml(selectedLabel)}</strong></span>
          <span>选择类型：<strong>${state.workbench.selectionMode === "face" ? "面级" : "零件级"}</strong></span>
          <span>零件 / 面数：<strong>${manifest.partCount} / ${manifest.faceCount}</strong></span>
        </div>
        <span data-role="status-hint">${escapeHtml(state.workbench.viewerHint)}</span>
      </footer>
    </main>
  `;
}

function renderVizPage() {
  if (state.loadingProjectId || !state.activeProject || !state.viz) {
    return `
      <div class="loading-state">
        <div class="loading-card glass-panel">
          <h2>正在加载零件可视化</h2>
          <p>正在读取项目数据，请稍候片刻。</p>
        </div>
      </div>
    `;
  }

  const { manifest } = state.activeProject;
  const selectedPartCount = state.viz.selectedPartIds.size;
  const visiblePartCount = state.viz.selectedPartIds.size > 0 ? state.viz.selectedPartIds.size : state.activeProject.partNodes.length;
  const hiddenPartCount = state.activeProject.partNodes.length - visiblePartCount;

  return `
    <main class="viz-shell">
      <header class="workbench-toolbar">
        <div class="toolbar-cluster">
          <button class="secondary-button" data-action="go-home">返回首页</button>
          <div class="toolbar-title">
            <strong>${escapeHtml(manifest.projectName)}</strong>
            <span>零件可视化</span>
          </div>
        </div>
        <div class="toolbar-cluster">
          <button class="toolbar-button" data-action="viewer-fit">适配</button>
          ${["front", "left", "top", "right", "back", "bottom"].map((preset) => renderPresetButton(preset)).join("")}
          <button class="toolbar-button ${state.viz.section.enabled ? "is-active" : ""}" data-action="toggle-section">剖切</button>
          <button class="toolbar-button" data-action="save-screenshot">截图</button>
          <button class="toolbar-button" data-action="capture-multi-angle">多角度</button>
        </div>
      </header>

      <section class="workbench-body">
        <aside class="viz-part-list">
          <div class="viz-part-list-header">
            <h3>零件列表</h3>
            <span class="viz-part-count">${state.activeProject.partNodes.length} 个零件</span>
          </div>
          <div class="viz-part-list-body">
            ${state.activeProject.partNodes.map((node) => {
              const isSelected = state.viz.selectedPartIds.has(node.id);
              return `
                <div class="viz-part-item ${isSelected ? "is-selected" : ""}" data-action="viz-select-part" data-node-id="${node.id}">
                  <span class="viz-part-color" style="background-color: ${node.color}"></span>
                  <span class="viz-part-name">${escapeHtml(node.name)}</span>
                </div>
              `;
            }).join("")}
          </div>
          <div class="viz-part-list-footer">
            <button class="secondary-button" data-action="viz-clear-selection">清除选择</button>
          </div>
        </aside>

        <section class="viewer-shell">
          <div class="viewer-grid"></div>
          <canvas id="viewer-canvas" class="viewer-canvas"></canvas>
          <div class="viewer-overlay-top">
            <div class="viewer-chip"><strong>视图模式</strong><span>零件可视化</span></div>
            <div class="viewer-chip"><strong>当前剖切</strong><span>${state.viz.section.enabled ? `${state.viz.section.axis.toUpperCase()} = ${Math.round(state.viz.section.offset)}` : "关闭"}</span></div>
          </div>
          <div class="viewer-floating">
            <div class="floating-card">
              <h4>已选零件</h4>
              <p>${selectedPartCount > 0 ? `${selectedPartCount} 个零件` : "未选择"}</p>
            </div>
            <div class="floating-card">
              <h4>显示摘要</h4>
              <p>可见零件 ${visiblePartCount} / ${state.activeProject.partNodes.length}</p>
            </div>
          </div>
          <div class="viewer-overlay-bottom">
            <div class="viewer-chip"><strong>操作提示</strong><span data-role="viewer-hint">${escapeHtml(state.viz.viewerHint)}</span></div>
          </div>
        </section>

        <aside class="side-panel">
          <div class="side-panel-header">
            <h3>显示控制</h3>
            <p>控制零件的显示与隐藏，整体视图展示不同零件颜色。</p>
          </div>
          <div class="side-panel-scroll">
            ${renderVizDisplayPanel()}
          </div>
        </aside>
      </section>

      <footer class="statusbar">
        <div class="status-items">
          <span>项目：<strong>${escapeHtml(manifest.projectName)}</strong></span>
          <span>选中零件：<strong>${selectedPartCount > 0 ? selectedPartCount : "全部"}</strong></span>
          <span>零件 / 面数：<strong>${manifest.partCount} / ${manifest.faceCount}</strong></span>
        </div>
        <span data-role="status-hint">${escapeHtml(state.viz.viewerHint)}</span>
      </footer>
    </main>
  `;
}

function renderVizDisplayPanel() {
  const { selectedPartIds, cameraParams } = state.viz;
  const selectedNodes = state.activeProject.partNodes.filter((n) => selectedPartIds.has(n.id));

  // 颜色与面映射卡片（如果有选中零件）
  const faceMappingCard = selectedNodes.length > 0 ? selectedNodes.map((node) => {
    const faces = node.faces || [];
    const bbox = node.bbox || {};

    return `
      <div class="panel-card">
        <h4>零件信息</h4>
        <div class="property-grid">
          <div class="property-row"><span>名称</span><strong>${escapeHtml(node.name)}</strong></div>
          <div class="property-row"><span>中心点</span><strong>${formatVector(bbox.center)}</strong></div>
          <div class="property-row"><span>尺寸</span><strong>${formatVector(bbox.size)}</strong></div>
          <div class="property-row"><span>面数</span><strong>${node.topology?.faceCount || faces.length}</strong></div>
        </div>
      </div>
      <div class="panel-card">
        <h4>颜色与面映射 (${faces.length} 面)</h4>
        <div class="face-color-list">
          ${faces.slice(0, 20).map((face, idx) => `
            <div class="face-color-item">
              <span class="face-color-swatch" style="background-color: ${face.renderColor || face.color || '#888888'}"></span>
              <span class="face-color-id">${face.id?.split(':').pop() || `Face ${idx + 1}`}</span>
              <span class="face-color-name">${escapeHtml(face.name || `面${idx + 1}`)}</span>
            </div>
          `).join("")}
          ${faces.length > 20 ? `<div class="face-color-more">还有 ${faces.length - 20} 个面...</div>` : ""}
        </div>
      </div>
    `;
  }).join("") : `
    <div class="panel-card">
      <h4>零件信息</h4>
      <p class="inline-note">请在左侧列表选择零件以查看详情</p>
    </div>
  `;

  // 参数化摄像机控制面板
  const colorModeLabel = state.viz.colorMode === "face" ? "面级着色" : "零件级着色";
  const cameraCard = `
    <div class="panel-card">
      <h4>显示模式</h4>
      <div class="color-mode-toggle">
        <button class="secondary-button ${state.viz.colorMode === "face" ? "is-active" : ""}" data-action="toggle-color-mode" data-mode="face">面级</button>
        <button class="secondary-button ${state.viz.colorMode === "part" ? "is-active" : ""}" data-action="toggle-color-mode" data-mode="part">零件级</button>
      </div>
      <p class="inline-note" style="margin-top: 8px;">当前：${colorModeLabel}</p>
    </div>
    <div class="panel-card">
      <h4>参数化摄像机</h4>
      <div class="camera-param-group">
        <div class="camera-param-row">
          <label>方位角</label>
          <input type="range" min="0" max="360" step="1" value="${cameraParams.azimuth}" data-bind="camera-azimuth" />
          <span class="param-value">${cameraParams.azimuth}°</span>
        </div>
        <div class="camera-param-row">
          <label>仰角</label>
          <input type="range" min="-90" max="90" step="1" value="${cameraParams.elevation}" data-bind="camera-elevation" />
          <span class="param-value">${cameraParams.elevation}°</span>
        </div>
        <div class="camera-param-row">
          <label>距离</label>
          <input type="range" min="50" max="2000" step="10" value="${cameraParams.distance}" data-bind="camera-distance" />
          <span class="param-value">${cameraParams.distance}</span>
        </div>
        <div class="camera-param-row">
          <label>旋转</label>
          <input type="range" min="-180" max="180" step="5" value="${cameraParams.roll}" data-bind="camera-roll" />
          <span class="param-value">${cameraParams.roll}°</span>
        </div>
      </div>
      <div class="camera-param-actions">
        <button class="secondary-button" data-action="apply-camera-params">应用参数</button>
        <button class="secondary-button" data-action="reset-camera-params">重置</button>
      </div>
    </div>
    <div class="panel-card">
      <h4>预设视角</h4>
      <div class="camera-preset-grid">
        ${["iso", "front", "back", "left", "right", "top", "bottom"].map((preset) => `
          <button class="secondary-button camera-preset-btn" data-action="viewer-preset" data-preset="${preset}">${presetLabelMap[preset]}</button>
        `).join("")}
      </div>
      <div class="camera-current-params">
        当前: <strong>Az ${cameraParams.azimuth}°</strong> <strong>El ${cameraParams.elevation}°</strong> <strong>D ${cameraParams.distance}</strong> <strong>Roll ${cameraParams.roll}°</strong>
      </div>
    </div>
  `;

  return faceMappingCard + cameraCard;
}

const presetLabelMap = {
  iso: "等轴测",
  front: "前视",
  back: "后视",
  left: "左视",
  right: "右视",
  top: "顶视",
  bottom: "底视",
};

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
      <h4>边界框与路线</h4>
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
        <button class="tree-visibility" data-action="toggle-visibility" data-node-id="${node.id}">${subtreeHidden ? "🙈" : "👁"}</button>
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
      <h4>当前可见性</h4>
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
      <p>首版先实现显隐与隔离的状态管理，后续接入真实 CAD 内核时可把这层直接映射为模型实例可见性控制。</p>
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
      <p style="margin-top: 12px;">当前保留负向半空间，便于从外部向内部逐步切入。</p>
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
    ? measure.picks.map((pick) => getSelectionLabel(pick)).join("  →  ")
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
  });
  state.viewer.setSelection(state.workbench.selection);
}

function mountVizViewer(snapshot) {
  const canvas = document.getElementById("viewer-canvas");
  if (!canvas || !state.activeProject || !state.viz) {
    destroyViewer();
    return;
  }

  destroyViewer();
  state.viewer = new WorkbenchViewer({
    canvas,
    onObjectPick: handleVizPick,
    onHintChange: updateVizHint,
  });

  // 设置零件隔离逻辑：如果有选中的零件，则只显示选中零件
  const { selectedPartIds } = state.viz;
  const hiddenNodeIds = new Set();
  if (selectedPartIds.size > 0) {
    state.activeProject.partNodes.forEach((node) => {
      if (!selectedPartIds.has(node.id)) {
        hiddenNodeIds.add(node.id);
      }
    });
  }

  const vizState = {
    selectionMode: "face",
    colorMode: state.viz.colorMode,
    hiddenNodeIds,
    isolatedNodeIds: selectedPartIds.size > 0 ? selectedPartIds : null,
    section: state.viz.section,
  };

  state.viewer.setScene(state.activeProject.assembly, { preserveCamera: Boolean(snapshot) });
  if (snapshot) {
    state.viewer.restore(snapshot);
  } else {
    // 应用摄像机参数
    const { azimuth, elevation, distance, roll } = state.viz.cameraParams;
    state.viewer.setCameraBySpherical(azimuth, elevation, distance, roll);
  }
  state.viewer.updateState(vizState);
  state.viewer.setSelection(null);
}

function syncVizViewerState() {
  if (!state.viewer || !state.viz) {
    return;
  }

  const { selectedPartIds, section, colorMode } = state.viz;
  const hiddenNodeIds = new Set();
  if (selectedPartIds.size > 0) {
    state.activeProject.partNodes.forEach((node) => {
      if (!selectedPartIds.has(node.id)) {
        hiddenNodeIds.add(node.id);
      }
    });
  }

  state.viewer.updateState({
    selectionMode: "face",
    colorMode,
    hiddenNodeIds,
    isolatedNodeIds: selectedPartIds.size > 0 ? selectedPartIds : null,
    section,
  });
}

function updateVizHint(message) {
  if (!state.viz) {
    return;
  }

  state.viz.viewerHint = message;
  const viewerHint = document.querySelector('[data-role="viewer-hint"]');
  const statusHint = document.querySelector('[data-role="status-hint"]');
  if (viewerHint) {
    viewerHint.textContent = message;
  }
  if (statusHint) {
    statusHint.textContent = message;
  }
}

function handleVizPick(pick) {
  // viz模式下可以选择面，但不改变零件选择
  updateVizHint(`悬停：${pick.label || "面"}`);
}

function updateViewerHint(message) {
  if (state.route.page === "viz") {
    updateVizHint(message);
    return;
  }
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

  const { action, projectId, nodeId, panel, preset, axis, mode } = actionTarget.dataset;

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
    case "open-viz":
      setRoute({ page: "viz", projectId });
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
    case "viewer-fit":
      state.viewer?.fit();
      return;
    case "viewer-preset":
      state.viewer?.setViewPreset(preset);
      // 如果是viz页面，更新摄像机参数状态
      if (state.route.page === "viz" && state.viz) {
        const params = state.viewer?.getCurrentSphericalParams();
        if (params) {
          state.viz.cameraParams = { ...params };
          render();
        }
      }
      updateViewerHint(`切换到${actionTarget.textContent.trim()}`);
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
    case "capture-multi-angle":
      await handleCaptureMultiAngle();
      return;
    case "set-panel":
      state.workbench.activePanel = panel;
      render();
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
    // viz页面相关操作
    case "viz-select-part":
      if (nodeId) {
        toggleVizPartSelection(nodeId);
        render();
      }
      return;
    case "viz-clear-selection":
      state.viz.selectedPartIds = new Set();
      syncVizViewerState();
      render();
      return;
    case "viz-isolate-selected":
      // 隔离选中零件（通过selectedPartIds实现）
      syncVizViewerState();
      render();
      return;
    case "viz-toggle-visibility":
      if (nodeId) {
        toggleVizNodeVisibility(nodeId);
        render();
      }
      return;
    case "viz-show-all":
      state.viz.hiddenNodeIds = new Set();
      state.viz.isolatedNodeIds = null;
      syncVizViewerState();
      render();
      return;
    case "viz-isolate":
      if (nodeId) {
        state.viz.selectedPartIds = new Set([nodeId]);
        syncVizViewerState();
        render();
      }
      return;
    case "viz-section-axis":
      state.viz.section.axis = axis;
      syncVizViewerState();
      render();
      return;
    case "toggle-section":
      if (state.route.page === "viz") {
        state.viz.section.enabled = !state.viz.section.enabled;
        syncVizViewerState();
        render();
      } else {
        state.workbench.section.enabled = !state.workbench.section.enabled;
        state.workbench.activePanel = "section";
        render();
      }
      return;
    case "apply-camera-params":
      applyVizCameraParams();
      return;
    case "reset-camera-params":
      resetVizCameraParams();
      return;
    case "toggle-color-mode":
      if (state.route.page === "viz" && state.viz && state.viewer && mode) {
        const newMode = mode;
        state.viz.colorMode = newMode;
        state.viewer.updateState({ colorMode: newMode });
        render();
      }
      return;
    default:
      break;
  }
}

function applyVizCameraParams() {
  if (!state.viewer || !state.viz) return;
  const { azimuth, elevation, distance, roll } = state.viz.cameraParams;
  state.viewer.setCameraBySpherical(azimuth, elevation, distance, roll);
  // 更新显示的当前参数
  const currentParams = document.querySelector(".camera-current-params");
  if (currentParams) {
    currentParams.innerHTML = `当前: <strong>Az ${azimuth}°</strong> <strong>El ${elevation}°</strong> <strong>D ${distance}</strong> <strong>Roll ${roll}°</strong>`;
  }
}

function resetVizCameraParams() {
  if (!state.viz) return;
  state.viz.cameraParams = { azimuth: 45, elevation: 30, distance: 200, roll: 0 };
  // 更新 UI
  document.querySelectorAll("[data-bind^='camera-']").forEach((input) => {
    const bind = input.dataset.bind;
    if (bind === "camera-azimuth") input.value = 45;
    if (bind === "camera-elevation") input.value = 30;
    if (bind === "camera-distance") input.value = 200;
    if (bind === "camera-roll") input.value = 0;
    // 触发更新显示值
    const evt = new Event("input", { bubbles: true });
    input.dispatchEvent(evt);
  });
  applyVizCameraParams();
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

  // 摄像机参数绑定
  if (state.route.page === "viz" && state.viz) {
    if (bind === "camera-azimuth") {
      state.viz.cameraParams.azimuth = Number(target.value);
      const output = target.parentElement.querySelector(".param-value");
      if (output) output.textContent = `${target.value}°`;
    }
    if (bind === "camera-elevation") {
      state.viz.cameraParams.elevation = Number(target.value);
      const output = target.parentElement.querySelector(".param-value");
      if (output) output.textContent = `${target.value}°`;
    }
    if (bind === "camera-distance") {
      state.viz.cameraParams.distance = Number(target.value);
      const output = target.parentElement.querySelector(".param-value");
      if (output) output.textContent = target.value;
    }
    if (bind === "camera-roll") {
      state.viz.cameraParams.roll = Number(target.value);
      const output = target.parentElement.querySelector(".param-value");
      if (output) output.textContent = `${target.value}°`;
    }
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

async function handleCaptureMultiAngle() {
  if (!state.viewer || !state.activeProject) {
    return;
  }

  pushToast("正在捕获多角度视图...", "info");

  try {
    const snapshots = await state.viewer.captureAngleSnapshots();

    for (const snapshot of snapshots) {
      await api.saveScreenshot({
        projectName: `${state.activeProject.manifest.projectName}_${snapshot.label}`,
        dataUrl: snapshot.dataUrl,
      });
    }

    pushToast(`已导出 ${snapshots.length} 张多角度视图。`, "success");
  } catch (error) {
    pushToast("多角度截图失败：" + error.message, "error");
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

function toggleVizPartSelection(nodeId) {
  if (!state.viz) {
    return;
  }
  const nextSelected = new Set(state.viz.selectedPartIds);
  if (nextSelected.has(nodeId)) {
    nextSelected.delete(nodeId);
  } else {
    nextSelected.add(nodeId);
  }
  state.viz.selectedPartIds = nextSelected;
}

function toggleVizNodeVisibility(nodeId) {
  if (!state.viz) {
    return;
  }
  const nextHidden = new Set(state.viz.hiddenNodeIds);
  if (nextHidden.has(nodeId)) {
    nextHidden.delete(nodeId);
  } else {
    nextHidden.add(nodeId);
  }
  state.viz.hiddenNodeIds = nextHidden;
  syncVizViewerState();
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
    label: `距离：${getSelectionLabel(leftSelection)} → ${getSelectionLabel(rightSelection)}`,
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
    label: `角度：${getSelectionLabel(leftSelection)} ↔ ${getSelectionLabel(rightSelection)}`,
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

// TCP Bridge: Handle invoke requests from Python
// 这些handler直接在渲染进程中执行，可以访问所有渲染进程数据
async function handleViewerInvoke({ id, method, params }) {
  console.error("[DEBUG] handleViewerInvoke called:", { id, method, params });
  try {
    const viewerApi = window.viewerApi;
    if (!viewerApi) {
      window.viewerApi?.returnResult(id, null, "viewerApi not available");
      return;
    }

    let result;

    // 直接在渲染进程中处理，不需要通过 IPC 调用主进程handler
    switch (method) {
      case "getState": {
        // 直接访问 state
        result = {
          projectId: state.activeProject?.manifest?.projectId || viewerState?.currentProjectId,
          route: state.route?.page || viewerState?.currentRoute
        };
        break;
      }
      case "getParts": {
        // 直接访问 activeProject.partNodes
        const activeProject = state.activeProject;
        if (!activeProject || !activeProject.partNodes) {
          result = { error: "No project loaded" };
        } else {
          result = {
            success: true,
            parts: activeProject.partNodes.map((part) => ({
              id: part.id,
              name: part.name,
              color: part.color,
              bbox: part.bbox,
              faceCount: part.topology?.faceCount || (part.faces || []).length,
            })),
          };
        }
        break;
      }
      case "getColorMapping": {
        const activeProject = state.activeProject;
        if (!activeProject || !activeProject.partNodes) {
          result = { error: "No project loaded" };
        } else {
          result = {
            projectName: activeProject.manifest?.projectName,
            parts: activeProject.partNodes.map((part) => ({
              id: part.id,
              name: part.name,
              color: part.color,
              bbox: part.bbox,
              faces: (part.faces || []).map((face) => ({
                id: face.id,
                color: face.renderColor || face.color,
                colorIndex: face.materialIndex || 0,
                name: face.name,
                center: face.center,
                normal: face.normal,
                area: face.area,
              })),
            })),
          };
        }
        break;
      }
      case "setColorMode":
        if (state.viz) {
          state.viz.colorMode = params?.mode;
        }
        if (state.viewer) {
          state.viewer.updateState({ colorMode: params?.mode });
        }
        result = { success: true, mode: params?.mode };
        break;
      case "setCamera": {
        if (state.viewer && params) {
          state.viewer.setCameraBySpherical(
            params.azimuth ?? 45,
            params.elevation ?? 30,
            params.distance ?? 200,
            params.roll ?? 0
          );
        }
        result = { success: true };
        break;
      }
      case "getCamera": {
        if (state.viewer) {
          result = { success: true, params: state.viewer.getCurrentSphericalParams() };
        } else {
          result = { error: "Viewer not ready" };
        }
        break;
      }
      case "setViewPreset": {
        if (state.viewer) {
          state.viewer.setViewPreset(params?.preset);
          result = { success: true };
        } else {
          result = { error: "Viewer not ready" };
        }
        break;
      }
      case "fit": {
        if (state.viewer) {
          state.viewer.fit();
        }
        result = { success: true };
        break;
      }
      case "captureScreenshot": {
        console.error("[DEBUG] captureScreenshot called, state.viewer:", !!state.viewer);
        const canvas = document.getElementById("viewer-canvas");
        if (!canvas) {
          console.error("[DEBUG] captureScreenshot: canvas not found");
          result = { error: "Canvas not found" };
        } else {
          const dataUrl = canvas.toDataURL("image/png");
          console.error("[DEBUG] captureScreenshot success, length:", dataUrl.length);
          result = {
            success: true,
            image: dataUrl.split(",")[1],
            mimeType: "image/png",
          };
        }
        break;
      }
      case "captureMultiview": {
        console.error("[DEBUG] captureMultiview called, state.viewer:", !!state.viewer);
        if (!state.viewer) {
          result = { error: "Viewer not ready" };
        } else {
          const defaultAngles = [
            { name: "iso", azimuth: 45, elevation: 30 },
            { name: "front", azimuth: 0, elevation: 0 },
            { name: "back", azimuth: 180, elevation: 0 },
            { name: "left", azimuth: 90, elevation: 0 },
            { name: "right", azimuth: -90, elevation: 0 },
            { name: "top", azimuth: 0, elevation: 90 },
            { name: "bottom", azimuth: 0, elevation: -90 },
          ];
          const targets = params?.angles || defaultAngles;
          const savedParams = state.viewer.getCurrentSphericalParams();
          const results = [];

          console.error("[DEBUG] captureMultiview starting, targets:", targets.length);
          for (const angle of targets) {
            console.error("[DEBUG] Processing angle:", angle.name);
            state.viewer.setCameraBySpherical(
              angle.azimuth,
              angle.elevation,
              angle.distance || savedParams.distance,
              0
            );
            // Use setTimeout instead of requestAnimationFrame for reliability
            await new Promise((r) => setTimeout(r, 50));
            const canvas = document.getElementById("viewer-canvas");
            results.push({
              name: angle.name,
              label: angle.label || angle.name,
              azimuth: angle.azimuth,
              elevation: angle.elevation,
              image: canvas?.toDataURL("image/png")?.split(",")[1] || null,
            });
            console.error("[DEBUG] Captured angle:", angle.name);
          }
          state.viewer.setCameraBySpherical(
            savedParams.azimuth,
            savedParams.elevation,
            savedParams.distance,
            savedParams.roll
          );
          console.error("[DEBUG] captureMultiview complete, results:", results.length);
          result = { success: true, views: results };
        }
        break;
      }
      case "setSection": {
        if (state.viz && params) {
          if (params.enabled !== undefined) state.viz.section.enabled = params.enabled;
          if (params.axis !== undefined) state.viz.section.axis = params.axis;
          if (params.offset !== undefined) state.viz.section.offset = params.offset;
        }
        if (state.viewer) {
          state.viewer.updateState({ section: state.viz?.section });
        }
        result = { success: true, section: state.viz?.section };
        break;
      }
      case "selectParts": {
        if (state.viz) {
          state.viz.selectedPartIds = new Set(params?.partIds || []);
          syncVizViewerState();
          render();
        }
        result = { success: true, selectedCount: params?.partIds?.length || 0 };
        break;
      }
      case "clearSelection": {
        if (state.viz) {
          state.viz.selectedPartIds = new Set();
          syncVizViewerState();
          render();
        }
        result = { success: true };
        break;
      }
      case "getSelectedParts": {
        const activeProject = state.activeProject;
        const selectedIds = state.viz?.selectedPartIds;
        if (!activeProject || !activeProject.partNodes) {
          result = { error: "No project loaded" };
        } else if (!selectedIds || selectedIds.size === 0) {
          result = { success: true, parts: [] };
        } else {
          const selectedParts = activeProject.partNodes
            .filter((p) => selectedIds.has(p.id))
            .map((part) => ({
              id: part.id,
              name: part.name,
              color: part.color,
              bbox: part.bbox,
              faces: (part.faces || []).map((face) => ({
                id: face.id,
                color: face.renderColor || face.color,
                colorIndex: face.materialIndex || 0,
                name: face.name,
                center: face.center,
                normal: face.normal,
                area: face.area,
              })),
            }));
          result = { success: true, parts: selectedParts };
        }
        break;
      }
      case "loadProject": {
        const projectId = params?.projectId;
        const route = params?.route || "viz";
        // 设置 hash 让 app 处理
        window.location.hash = route === "workbench" ? `#/workbench/${projectId}` : `#/viz/${projectId}`;
        // 等待 viewer 就绪（最多 10 秒）
        const startTime = Date.now();
        while (!state.viewer && Date.now() - startTime < 10000) {
          await new Promise((r) => setTimeout(r, 100));
        }
        result = state.viewer ? { success: true } : { error: "Viewer init timeout" };
        break;
      }
      case "listProjects": {
        result = await api.listProjects();
        break;
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }

    console.error("[DEBUG] handleViewerInvoke returning result:", { id, hasResult: !!result, resultKeys: result ? Object.keys(result) : null });
    window.viewerApi?.returnResult(id, result);
  } catch (error) {
    console.error("[DEBUG] handleViewerInvoke error:", error.message);
    window.viewerApi?.returnResult(id, null, error.message);
  }
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
