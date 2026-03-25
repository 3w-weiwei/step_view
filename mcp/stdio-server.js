const path = require("path");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  configureProjectRoot,
  ensureProjectStore,
  listProjects,
  getProjectDetails,
} = require("../project-service");
const { createMcpRuntime } = require("./runtime");

function createStdioAdapter() {
  configureProjectRoot(path.join(process.cwd(), "project-data"));

  return {
    async listProjects() {
      await ensureProjectStore();
      return listProjects();
    },
    async getProjectDetails(projectId) {
      return getProjectDetails(projectId);
    },
    async getRendererState() {
      return {
        route: "headless",
        currentProjectId: null,
        selection: null,
        section: null,
        camera: null,
        isolation: [],
        colorMaps: {
          display: [],
          "id-mask": [],
        },
      };
    },
    async executeRendererCommand() {
      throw new Error("stdio 模式下没有运行中的 Electron renderer，无法执行交互命令。");
    },
    async captureRenderer() {
      throw new Error("stdio 模式下没有运行中的 Electron renderer，无法截图。");
    },
  };
}

async function startStdioServer() {
  const server = createMcpRuntime(createStdioAdapter());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  startStdioServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  startStdioServer,
};
