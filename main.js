const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs/promises");
const path = require("path");

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
}

app.whenReady().then(async () => {
  configureProjectRoot(resolveProjectRoot());
  await ensureProjectStore();
  onProjectUpdate(broadcastProjectUpdate);
  registerIpcHandlers();
  createMainWindow();

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
