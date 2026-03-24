const fs = require("fs/promises");
const path = require("path");
const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");

const { buildMockProjectPayload } = require("./mock-cad");

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

async function getProjectManifest(projectId) {
  try {
    return await readJson(getManifestPath(projectId));
  } catch (_error) {
    return null;
  }
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

async function simulateParse(projectId) {
  if (parseJobs.has(projectId)) {
    return;
  }

  const jobState = { canceled: false };
  parseJobs.set(projectId, jobState);

  const phases = [
    { label: "校验 STEP 文件", from: 0, to: 12, ticks: 3 },
    { label: "提取装配结构", from: 12, to: 34, ticks: 4 },
    { label: "读取 BRep 数据", from: 34, to: 58, ticks: 4 },
    { label: "网格化处理中", from: 58, to: 82, ticks: 5 },
    { label: "生成缩略图", from: 82, to: 94, ticks: 3 },
    { label: "写入本地缓存", from: 94, to: 100, ticks: 2 },
  ];

  try {
    const manifest = await getProjectManifest(projectId);
    if (!manifest) {
      return;
    }

    await updateManifest(projectId, {
      status: "parsing",
      progress: 2,
      currentStage: phases[0].label,
      errorSummary: "",
    });

    const sourceExists = await fileExists(getCachedSourcePath(projectId));
    if (!sourceExists) {
      throw new Error("缓存中的 STEP 文件缺失，无法继续解析。");
    }

    const shouldFail =
      !/\.stp$|\.step$/i.test(manifest.sourceFileName) ||
      /fail|broken|error/i.test(manifest.sourceFileName);

    for (const phase of phases) {
      for (let tick = 0; tick < phase.ticks; tick += 1) {
        await delay(220 + tick * 40);
        if (jobState.canceled) {
          return;
        }

        const progress =
          phase.from + ((phase.to - phase.from) * (tick + 1)) / phase.ticks;
        await updateManifest(projectId, {
          status: "parsing",
          progress: Math.round(progress),
          currentStage: phase.label,
        });

        if (shouldFail && phase.label === "读取 BRep 数据" && tick === phase.ticks - 1) {
          throw new Error("BRep 读取失败：检测到无法闭合的几何体，请尝试重新导出 STEP。");
        }
      }
    }

    const nextManifest = await getProjectManifest(projectId);
    if (!nextManifest) {
      return;
    }

    const assembly = buildMockProjectPayload({
      projectName: nextManifest.projectName,
      sourceFileName: nextManifest.sourceFileName,
      fileSizeBytes: nextManifest.sourceFileSize,
    });

    await writeJson(getAssemblyPath(projectId), assembly);
    await fs.writeFile(getThumbnailPath(projectId), assembly.thumbnailSvg, "utf8");

    await updateManifest(projectId, {
      status: "ready",
      progress: 100,
      currentStage: "解析完成，可进入工作台",
      assemblyCount: assembly.stats.assemblyCount,
      partCount: assembly.stats.partCount,
      faceCount: assembly.stats.faceCount,
      thumbnailPath: "./thumbnail.svg",
      errorSummary: "",
      bounds: assembly.bounds,
    });
  } catch (error) {
    if (!jobState.canceled) {
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

  simulateParse(projectId).catch(() => {});

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

  simulateParse(projectId).catch(() => {});
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
