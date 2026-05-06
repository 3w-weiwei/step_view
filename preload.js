const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cadViewerApi", {
  pickStepFiles() {
    return ipcRenderer.invoke("system:pick-step-files");
  },
  listProjects() {
    return ipcRenderer.invoke("projects:list");
  },
  importProjects(filePaths) {
    return ipcRenderer.invoke("projects:import", { filePaths });
  },
  getProjectDetails(projectId) {
    return ipcRenderer.invoke("projects:details", projectId);
  },
  retryProject(projectId) {
    return ipcRenderer.invoke("projects:retry", projectId);
  },
  renameProject(projectId, name) {
    return ipcRenderer.invoke("projects:rename", { projectId, name });
  },
  deleteProject(projectId) {
    return ipcRenderer.invoke("projects:delete", projectId);
  },
  openSourceDir(projectId) {
    return ipcRenderer.invoke("projects:open-source-dir", projectId);
  },
  saveScreenshot(payload) {
    return ipcRenderer.invoke("system:save-screenshot", payload);
  },
  syncViewerState(projectId, route) {
    return ipcRenderer.invoke("viewer:sync-state", { projectId, route });
  },
  onProjectUpdate(callback) {
    const listener = (_event, payload) => {
      callback(payload);
    };

    ipcRenderer.on("projects:updated", listener);

    return () => {
      ipcRenderer.removeListener("projects:updated", listener);
    };
  },
});

// 暴露 Viewer API 给渲染进程
contextBridge.exposeInMainWorld("viewerApi", {
  // 状态
  getState() {
    return ipcRenderer.invoke("viewer:get-state");
  },

  // 项目操作
  loadProject(projectId, route = "viz") {
    return ipcRenderer.invoke("viewer:load-project", { projectId, route });
  },
  listProjects() {
    return ipcRenderer.invoke("viewer:list-projects");
  },
  importStep(filePath) {
    return ipcRenderer.invoke("viewer:import-step", { filePath });
  },

  // 零件操作
  getParts() {
    return ipcRenderer.invoke("viewer:get-parts");
  },
  selectParts(partIds) {
    return ipcRenderer.invoke("viewer:select-parts", { partIds });
  },
  clearSelection() {
    return ipcRenderer.invoke("viewer:clear-selection");
  },
  getSelectedParts() {
    return ipcRenderer.invoke("viewer:get-selected-parts");
  },

  // 着色模式
  setColorMode(mode) {
    return ipcRenderer.invoke("viewer:set-color-mode", { mode });
  },

  // 摄像机
  setCamera(azimuth, elevation, distance, roll) {
    return ipcRenderer.invoke("viewer:set-camera", { azimuth, elevation, distance, roll });
  },
  getCamera() {
    return ipcRenderer.invoke("viewer:get-camera");
  },
  setViewPreset(preset) {
    return ipcRenderer.invoke("viewer:set-view-preset", { preset });
  },
  fit() {
    return ipcRenderer.invoke("viewer:fit");
  },

  // 截图
  captureScreenshot() {
    return ipcRenderer.invoke("viewer:capture-screenshot");
  },
  captureMultiview(angles) {
    return ipcRenderer.invoke("viewer:capture-multiview", { angles });
  },

  // 剖切
  setSection(enabled, axis, offset) {
    return ipcRenderer.invoke("viewer:set-section", { enabled, axis, offset });
  },

  // 颜色映射
  getColorMapping() {
    return ipcRenderer.invoke("viewer:get-color-mapping");
  },

  // TCP Bridge: 接收来自主进程的调用请求
  onViewerInvoke(callback) {
    const listener = (_event, payload) => {
      console.error("[PRELOAD] viewer:invoke received:", payload);
      callback(payload);
    };
    ipcRenderer.on("viewer:invoke", listener);
    return () => {
      ipcRenderer.removeListener("viewer:invoke", listener);
    };
  },

  // TCP Bridge: 返回结果给主进程
  returnResult(id, result, error) {
    console.error("[PRELOAD] viewer:return sending:", { id, hasResult: !!result, hasError: !!error });
    ipcRenderer.send("viewer:return", { id, result, error });
  },

  // TCP Bridge: 监听导航消息
  onNavigate(callback) {
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on("viewer:navigate", listener);
    return () => {
      ipcRenderer.removeListener("viewer:navigate", listener);
    };
  },
});
