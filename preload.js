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
