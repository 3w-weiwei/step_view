const fs = require("fs/promises");
const path = require("path");
const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");
const { fork } = require("child_process");

const { buildProjectPayloadFromStepFile } = require("./step-parser");
const { parseStepWithOcct } = require("./occt-sidecar");

const updates = new EventEmitter();
const parseJobs = new Map();

let projectRoot = null;

function configureProjectRoot(rootDirectory) {
  projectRoot = rootDirectory;
}

function getProjectRoot() {
  if (!projectRoot) {
    throw new Error("项目缓存目录尚未初始化。");
  }
  return projectRoot;
}

function getProjectDirectory(projectId) {
  return path.join(getProjectRoot(), projectId);
}

function getManifestPath(projectId) {
  return path.join(getProjectDirectory(projectId), "manifest.json");
}

function getAssemblyPath(projectId) {
  return path.join(getProjectDirectory(projectId), "assembly.json");
}

function getCachedSourcePath(projectId) {
  return path.join(getProjectDirectory(projectId), "source.step");
}

function getThumbnailPath(projectId) {
  return path.join(getProjectDirectory(projectId), "thumbnail.svg");
}

async function ensureProjectStore() {
  await fs.mkdir(getProjectRoot(), { recursive: true });
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function sortProjects(projects) {
  return [...projects].sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
    const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
    return rightTime - leftTime;
  });
}

function emitProjectUpdate(payload) {
  updates.emit("update", payload);
}

function onProjectUpdate(listener) {
  updates.on("update", listener);
}

function extensionToMime(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".png") {
    return "image/png";
  }
  return "application/octet-stream";
}

async function readThumbnailDataUrl(projectId) {
  const thumbnailPath = getThumbnailPath(projectId);
  if (!(await fileExists(thumbnailPath))) {
    return null;
  }

  const buffer = await fs.readFile(thumbnailPath);
  const mimeType = extensionToMime(thumbnailPath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function projectDirectories() {
  const entries = await fs.readdir(getProjectRoot(), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function getProjectManifest(projectId) {
  try {
    return await readJson(getManifestPath(projectId));
  } catch (_error) {
    return null;
  }
}

async function summarizeProject(projectId) {
  const manifest = await getProjectManifest(projectId);
  if (!manifest) {
    return null;
  }

  return {
    ...manifest,
    thumbnailDataUrl: await readThumbnailDataUrl(projectId),
  };
}

async function listProjects() {
  await ensureProjectStore();
  const summaries = await Promise.all((await projectDirectories()).map((projectId) => summarizeProject(projectId)));
  return sortProjects(summaries.filter(Boolean));
}

async function updateManifest(projectId, patch) {
  const current = await getProjectManifest(projectId);
  if (!current) {
    throw new Error("项目不存在。");
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await writeJson(getManifestPath(projectId), next);
  const summary = await summarizeProject(projectId);
  emitProjectUpdate(summary);
  return next;
}

async function getProjectDetails(projectId) {
  const manifest = await getProjectManifest(projectId);
  if (!manifest) {
    return null;
  }

  let assembly = null;
  if (manifest.status === "ready" && (await fileExists(getAssemblyPath(projectId)))) {
    assembly = await readJson(getAssemblyPath(projectId));
  }

  return {
    manifest: {
      ...manifest,
      thumbnailDataUrl: await readThumbnailDataUrl(projectId),
    },
    assembly,
  };
}

function delay(duration) {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}

function parseWithOcctSidecar(sourcePath, options) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, "occt-sidecar.js"), [], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("message", (message) => {
      if (message?.type === "success") {
        resolve(message.payload);
        return;
      }
      if (message?.type === "error") {
        reject(new Error(message.error || stderr || "OCCT sidecar 执行失败。"));
      }
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code !== 0 && stderr.trim()) {
        reject(new Error(stderr.trim()));
      }
    });

    child.send({
      command: "parse-step",
      inputPath: sourcePath,
      options,
    });
  });
}

async function runParsePipeline(projectId) {
  if (parseJobs.has(projectId)) {
    return;
  }

  const jobState = { canceled: false };
  parseJobs.set(projectId, jobState);

  const stages = [
    { label: "校验 STEP 文件", progress: 6 },
    { label: "读取 STEP 文本", progress: 24 },
    { label: "提取装配结构与实例关系", progress: 52 },
    { label: "生成代理几何与缩略图", progress: 82 },
    { label: "写入项目缓存", progress: 96 },
  ];

  async function publishStage(label, progress) {
    if (jobState.canceled) {
      throw new Error("__CANCELED__");
    }
    await updateManifest(projectId, {
      status: "parsing",
      progress,
      currentStage: label,
      errorSummary: "",
    });
    await delay(80);
  }

  try {
    const manifest = await getProjectManifest(projectId);
    if (!manifest) {
      return;
    }

    const sourcePath = getCachedSourcePath(projectId);
    if (!(await fileExists(sourcePath))) {
      throw new Error("缓存中的 STEP 文件缺失，无法继续解析。");
    }

    await publishStage(stages[0].label, stages[0].progress);
    await publishStage(stages[1].label, stages[1].progress);
    let assembly;
    let parserMode = "occt-sidecar";
    let geometryMode = "triangulated-mesh";

    try {
      assembly = await parseWithOcctSidecar(sourcePath, {
        projectName: manifest.projectName,
        sourceFileName: manifest.sourceFileName,
        sourceSchema: manifest.sourceSchema || null,
        unitLabel: manifest.unitLabel || "mm",
      });
    } catch (sidecarError) {
      try {
        assembly = await parseStepWithOcct(sourcePath, {
          projectName: manifest.projectName,
          sourceFileName: manifest.sourceFileName,
          sourceSchema: manifest.sourceSchema || null,
          unitLabel: manifest.unitLabel || "mm",
        });
        parserMode = "occt-embedded";
        geometryMode = "triangulated-mesh";
        assembly.meta = {
          ...(assembly.meta || {}),
          fallbackReason: sidecarError.message,
        };
      } catch (embeddedError) {
        assembly = await buildProjectPayloadFromStepFile(sourcePath, {
          projectName: manifest.projectName,
          sourceFileName: manifest.sourceFileName,
        });
        parserMode = "step-text";
        geometryMode = "bbox-proxy";
        assembly.meta = {
          ...(assembly.meta || {}),
          fallbackReason: `${sidecarError.message}; ${embeddedError.message}`,
        };
      }
    }

    await publishStage(
      parserMode === "occt-sidecar" ? "OCCT sidecar 网格化与层级构建" : stages[2].label,
      stages[2].progress,
    );
    await publishStage(
      parserMode === "occt-sidecar" ? "生成工作台缓存与缩略图" : stages[3].label,
      stages[3].progress,
    );

    await writeJson(getAssemblyPath(projectId), assembly);
    await publishStage(stages[4].label, stages[4].progress);
    await fs.writeFile(getThumbnailPath(projectId), assembly.thumbnailSvg, "utf8");

    await updateManifest(projectId, {
      status: "ready",
      progress: 100,
      currentStage:
        geometryMode === "triangulated-mesh"
          ? "OCCT 真实网格解析完成，可进入工作台"
          : "真实 STEP 解析完成，可进入工作台",
      assemblyCount: assembly.stats.assemblyCount,
      partCount: assembly.stats.partCount,
      faceCount: assembly.stats.faceCount,
      solidCount: assembly.stats.solidCount,
      thumbnailPath: "./thumbnail.svg",
      errorSummary: "",
      bounds: assembly.bounds,
      parserMode,
      geometryMode,
      sourceSchema: assembly.meta.sourceSchema,
      modelName: assembly.meta.sourceModelName,
      unitLabel: assembly.meta.unitLabel,
    });
  } catch (error) {
    if (!jobState.canceled && error.message !== "__CANCELED__") {
      await updateManifest(projectId, {
        status: "failed",
        progress: 0,
        currentStage: "解析失败",
        errorSummary: error.message,
      });
    }
  } finally {
    parseJobs.delete(projectId);
  }
}

async function findDuplicateProject(filePath, fileSize) {
  const projects = await listProjects();
  return (
    projects.find(
      (project) =>
        project.sourceFilePath === filePath ||
        (project.sourceFileName === path.basename(filePath) && project.sourceFileSize === fileSize),
    ) || null
  );
}

async function importProjectFromFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (![".step", ".stp"].includes(extension)) {
    throw new Error("仅支持导入 .step / .stp 文件。");
  }

  const stats = await fs.stat(filePath);
  const duplicateProject = await findDuplicateProject(filePath, stats.size);
  if (duplicateProject) {
    return {
      ...duplicateProject,
      duplicate: true,
    };
  }

  const now = new Date().toISOString();
  const projectId = randomUUID();
  const projectName = path.basename(filePath, extension);
  const projectDirectory = getProjectDirectory(projectId);
  const manifest = {
    projectId,
    projectName,
    sourceFileName: path.basename(filePath),
    sourceFilePath: filePath,
    sourceFileSize: stats.size,
    status: "pending",
    progress: 0,
    currentStage: "等待进入解析队列",
    assemblyCount: 0,
    partCount: 0,
    faceCount: 0,
    solidCount: 0,
    parserMode: "step-text",
    geometryMode: "bbox-proxy",
    thumbnailPath: "",
    errorSummary: "",
    createdAt: now,
    updatedAt: now,
  };

  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.copyFile(filePath, getCachedSourcePath(projectId));
  await writeJson(getManifestPath(projectId), manifest);

  emitProjectUpdate({
    ...manifest,
    thumbnailDataUrl: null,
  });

  runParsePipeline(projectId).catch(() => {});
  return manifest;
}

async function retryProject(projectId) {
  const manifest = await getProjectManifest(projectId);
  if (!manifest) {
    throw new Error("项目不存在。");
  }

  await updateManifest(projectId, {
    status: "pending",
    progress: 0,
    currentStage: "等待重新解析",
    errorSummary: "",
  });

  runParsePipeline(projectId).catch(() => {});
  return summarizeProject(projectId);
}

async function renameProject(projectId, nextName) {
  const trimmedName = (nextName || "").trim();
  if (!trimmedName) {
    throw new Error("项目名称不能为空。");
  }

  await updateManifest(projectId, {
    projectName: trimmedName,
  });

  return summarizeProject(projectId);
}

async function deleteProject(projectId) {
  const job = parseJobs.get(projectId);
  if (job) {
    job.canceled = true;
  }

  await fs.rm(getProjectDirectory(projectId), { recursive: true, force: true });
  emitProjectUpdate({ projectId, deleted: true });
  return { ok: true };
}

module.exports = {
  configureProjectRoot,
  ensureProjectStore,
  getProjectDirectory,
  getProjectManifest,
  getProjectDetails,
  importProjectFromFile,
  listProjects,
  onProjectUpdate,
  renameProject,
  retryProject,
  deleteProject,
};
