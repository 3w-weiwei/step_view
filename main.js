const { app, BrowserWindow, dialog, ipcMain, shell, ipcRenderer } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const net = require("net");

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

const { registerViewerApiHandlers } = require("./viewer-api");

let mainWindow = null;
let tcpServer = null;
const TCP_PORT = 3100;

// IPC Bridge: Handle commands from ipc-client.js (Python bridge)
function setupTcpBridge() {
  tcpServer = net.createServer((clientSocket) => {
    console.error("[TCP Bridge] Client connected from Python");

    let clientBuffer = "";

    clientSocket.on("data", async (data) => {
      clientBuffer += data.toString();
      const messages = clientBuffer.split("\n");
      clientBuffer = messages.pop() || "";

      for (const rawMsg of messages) {
        const trimmed = rawMsg.trim();
        if (!trimmed) continue;

        try {
          const message = JSON.parse(trimmed);
          console.error("[TCP Bridge] Received:", message);
          await handleTcpMessage(clientSocket, message);
        } catch (e) {
          console.error("[TCP Bridge] Parse error:", e.message);
          clientSocket.write(JSON.stringify({ error: `Parse error: ${e.message}`, id: null }) + "\n");
        }
      }
    });

    clientSocket.on("close", () => {
      console.error("[TCP Bridge] Client disconnected");
    });

    clientSocket.on("error", (err) => {
      console.error("[TCP Bridge] Socket error:", err.message);
    });
  });

  tcpServer.listen(TCP_PORT, "127.0.0.1", () => {
    console.error(`[TCP Bridge] Listening on 127.0.0.1:${TCP_PORT}`);
  });

  tcpServer.on("error", (err) => {
    console.error("[TCP Bridge] Server error:", err.message);
  });
}

async function handleTcpMessage(clientSocket, message) {
  const { type, id, method, params } = message;

  if (type === "invoke") {
    // Forward to renderer and wait for result
    if (!mainWindow || mainWindow.isDestroyed()) {
      clientSocket.write(JSON.stringify({ type: "invoke-result", id, error: "Window not available" }) + "\n");
      return;
    }

    const timeoutMs = 30000;
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Renderer invoke timeout")), timeoutMs)
    );

    const invokePromise = new Promise((resolve, reject) => {
      // Set up one-time listener for the result from renderer
      const handler = (event, { id: resultId, result, error }) => {
        console.error("[TCP Bridge] viewer:return received:", { resultId, id, hasResult: !!result, hasError: !!error });
        if (resultId === id) {
          ipcMain.removeListener("viewer:return", handler);
          if (error) reject(new Error(error));
          else resolve(result);
        }
      };
      ipcMain.on("viewer:return", handler);
    });

    try {
      // Send invoke to renderer via webContents
      console.error("[TCP Bridge] Sending viewer:invoke to renderer:", { id, method, params });
      mainWindow.webContents.send("viewer:invoke", { id, method, params });

      const result = await Promise.race([invokePromise, timeout]);
      console.error("[TCP Bridge] Invoke success, writing to socket");
      clientSocket.write(JSON.stringify({ type: "invoke-result", id, result }) + "\n");
    } catch (error) {
      console.error("[TCP Bridge] Invoke error:", error.message);
      clientSocket.write(JSON.stringify({ type: "invoke-result", id, error: error.message }) + "\n");
    } finally {
      // Clean up listener
      ipcMain.removeAllListeners("viewer:return");
    }
  } else if (type === "list-methods") {
    // Return list of available methods
    const methods = [
      "getState", "loadProject", "listProjects", "importStep",
      "getParts", "selectParts", "clearSelection", "getSelectedParts",
      "setColorMode", "setCamera", "getCamera", "setViewPreset", "fit",
      "captureScreenshot", "captureMultiview", "setSection", "getColorMapping"
    ];
    clientSocket.write(JSON.stringify({ type: "methods", id, result: methods }) + "\n");
  }
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
}

function broadcastProjectUpdate(project) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("projects:updated", project);
  }
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

function registerIpcHandlers() {
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

  // Viewer state sync handler (called from render process via cadViewerApi)
  ipcMain.handle("viewer:sync-state", async (_event, { projectId, route }) => {
    // This handler exists for historical reasons; state sync is handled in render process
    return { projectId, route };
  });
}

app.whenReady().then(async () => {
  configureProjectRoot(resolveProjectRoot());
  await ensureProjectStore();
  onProjectUpdate(broadcastProjectUpdate);
  registerIpcHandlers();
  setupTcpBridge(); // TCP bridge for Python IPC
  createMainWindow();
  registerViewerApiHandlers(mainWindow); // 注册可视化工具 API (需要 mainWindow)

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
