const { contextBridge, ipcRenderer } = require("electron");

let mcpCaptureHandler = null;
let mcpCommandHandler = null;
let mcpServerStatusListener = null;

ipcRenderer.on("mcp:capture:request", async (_event, payload) => {
  if (!mcpCaptureHandler) {
    ipcRenderer.send("mcp:capture:response", {
      requestId: payload?.requestId,
      ok: false,
      error: "Renderer 未注册 MCP capture handler。",
    });
    return;
  }

  try {
    const result = await mcpCaptureHandler(payload);
    ipcRenderer.send("mcp:capture:response", {
      requestId: payload?.requestId,
      ok: true,
      result,
    });
  } catch (error) {
    ipcRenderer.send("mcp:capture:response", {
      requestId: payload?.requestId,
      ok: false,
      error: error?.message || String(error),
    });
  }
});

ipcRenderer.on("mcp:command:request", async (_event, payload) => {
  if (!mcpCommandHandler) {
    ipcRenderer.send("mcp:command:response", {
      requestId: payload?.requestId,
      ok: false,
      error: "Renderer 未注册 MCP command handler。",
    });
    return;
  }

  try {
    const result = await mcpCommandHandler(payload);
    ipcRenderer.send("mcp:command:response", {
      requestId: payload?.requestId,
      ok: true,
      result,
    });
  } catch (error) {
    ipcRenderer.send("mcp:command:response", {
      requestId: payload?.requestId,
      ok: false,
      error: error?.message || String(error),
    });
  }
});

ipcRenderer.on("mcp:server-status", (_event, payload) => {
  if (typeof mcpServerStatusListener === "function") {
    mcpServerStatusListener(payload);
  }
});

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
  getMcpServerStatus() {
    return ipcRenderer.invoke("mcp:server-status:get");
  },
  getReasoningSummary(projectId) {
    return ipcRenderer.invoke("reasoning:summary", projectId);
  },
  getReasoningConstraints(payload) {
    return ipcRenderer.invoke("reasoning:constraints", payload);
  },
  getReasoningTransform(payload) {
    return ipcRenderer.invoke("reasoning:transform", payload);
  },
  getReasoningPlan(payload) {
    return ipcRenderer.invoke("reasoning:plan", payload);
  },
  getReasoningStep(payload) {
    return ipcRenderer.invoke("reasoning:step", payload);
  },
  captureReasoningStepPreview(payload) {
    return ipcRenderer.invoke("reasoning:step-preview", payload);
  },
  publishMcpState(payload) {
    ipcRenderer.send("mcp:state:update", payload);
  },
  registerMcpCaptureHandler(callback) {
    mcpCaptureHandler = callback;
    return () => {
      if (mcpCaptureHandler === callback) {
        mcpCaptureHandler = null;
      }
    };
  },
  registerMcpCommandHandler(callback) {
    mcpCommandHandler = callback;
    return () => {
      if (mcpCommandHandler === callback) {
        mcpCommandHandler = null;
      }
    };
  },
  onMcpServerStatus(callback) {
    mcpServerStatusListener = callback;
    return () => {
      if (mcpServerStatusListener === callback) {
        mcpServerStatusListener = null;
      }
    };
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
