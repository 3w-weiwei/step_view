const { randomUUID } = require("crypto");

let windowProvider = null;
let rendererState = {
  route: "home",
  currentProjectId: null,
};

const pendingCaptures = new Map();
const pendingCommands = new Map();

function setWindowProvider(provider) {
  windowProvider = provider;
}

function updateRendererState(nextState) {
  rendererState = {
    ...rendererState,
    ...(nextState || {}),
    updatedAt: new Date().toISOString(),
  };
}

function getRendererState() {
  return JSON.parse(JSON.stringify(rendererState));
}

function handleCaptureResponse(payload) {
  const requestId = payload?.requestId;
  if (!requestId || !pendingCaptures.has(requestId)) {
    return;
  }

  const { resolve, reject, timeoutId } = pendingCaptures.get(requestId);
  clearTimeout(timeoutId);
  pendingCaptures.delete(requestId);

  if (payload.ok) {
    resolve(payload.result);
  } else {
    reject(new Error(payload.error || "Renderer capture failed."));
  }
}

function handleCommandResponse(payload) {
  const requestId = payload?.requestId;
  if (!requestId || !pendingCommands.has(requestId)) {
    return;
  }

  const { resolve, reject, timeoutId } = pendingCommands.get(requestId);
  clearTimeout(timeoutId);
  pendingCommands.delete(requestId);

  if (payload.ok) {
    resolve(payload.result);
  } else {
    reject(new Error(payload.error || "Renderer command failed."));
  }
}

function requestRendererCapture(options = {}) {
  const targetWindow = windowProvider ? windowProvider() : null;
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error("没有可用的窗口用于截图。");
  }

  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingCaptures.delete(requestId);
      reject(new Error("等待 renderer capture 响应超时。"));
    }, 15000);

    pendingCaptures.set(requestId, {
      resolve,
      reject,
      timeoutId,
    });

    targetWindow.webContents.send("mcp:capture:request", {
      requestId,
      ...options,
    });
  });
}

function requestRendererCommand(options = {}) {
  const targetWindow = windowProvider ? windowProvider() : null;
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error("没有可用的窗口用于执行命令。");
  }

  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error("等待 renderer command 响应超时。"));
    }, 15000);

    pendingCommands.set(requestId, {
      resolve,
      reject,
      timeoutId,
    });

    targetWindow.webContents.send("mcp:command:request", {
      requestId,
      ...options,
    });
  });
}

module.exports = {
  setWindowProvider,
  updateRendererState,
  getRendererState,
  requestRendererCapture,
  requestRendererCommand,
  handleCaptureResponse,
  handleCommandResponse,
};
