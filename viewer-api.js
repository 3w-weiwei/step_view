/**
 * Viewer API - 用于外部调用的完整可视化工具接口
 *
 * 注意: 大部分 IPC handlers 已移至 app.js 的 handleViewerInvoke 中处理。
 * 此文件仅用于:
 * 1. 注册 TCP Bridge 相关的 IPC 处理
 * 2. 提供等待视图/项目加载的辅助函数
 */

const { ipcMain } = require("electron");

let mainWindowRef = null;

// 注册 TCP Bridge 的 IPC 处理
function registerViewerApiHandlers(mainWindow) {
  mainWindowRef = mainWindow;
}

// 发送导航消息到渲染进程
function sendNavigate(projectId, route) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send("viewer:navigate", { projectId, route });
  }
}

// 等待视图加载完成
function waitForViewerReady(timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      const { viewer } = globalThis._appState || {};
      if (viewer) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error("Viewer ready timeout"));
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

// 等待项目数据加载完成
function waitForProjectLoaded(projectId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      const { activeProject } = globalThis._appState || {};
      if (activeProject?.manifest?.projectId === projectId) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error("Project load timeout"));
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

module.exports = {
  registerViewerApiHandlers,
  sendNavigate,
  waitForViewerReady,
  waitForProjectLoaded
};
