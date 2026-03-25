const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpRuntime } = require("./runtime");

function createServerApp(adapter, getPort) {
  const app = createMcpExpressApp();

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: "step-workbench-mcp",
      transport: "streamable-http",
      port: getPort(),
    });
  });

  app.post("/mcp", async (req, res) => {
    const server = createMcpRuntime(adapter);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error?.message || "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      }),
    );
  });

  app.delete("/mcp", async (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      }),
    );
  });

  return app;
}

function canRetryPort(error) {
  return Boolean(error && ["EACCES", "EADDRINUSE"].includes(error.code));
}

function listenOnPort(app, host, port) {
  return new Promise((resolve, reject) => {
    const listener = app.listen(port, host);
    listener.once("listening", () => resolve(listener));
    listener.once("error", (error) => {
      listener.removeAllListeners("listening");
      reject(error);
    });
  });
}

async function startMcpHttpServer(adapter, options = {}) {
  const host = options.host || "127.0.0.1";
  const preferredPort = options.port || 3765;
  const fallbackPorts = options.fallbackPorts || [preferredPort + 1, preferredPort + 2, preferredPort + 3, 0];
  let activePort = preferredPort;
  const app = createServerApp(adapter, () => activePort);

  let listener = null;
  let lastError = null;
  const portCandidates = [preferredPort, ...fallbackPorts.filter((port, index, list) => list.indexOf(port) === index && port !== preferredPort)];

  for (const candidatePort of portCandidates) {
    try {
      listener = await listenOnPort(app, host, candidatePort);
      const address = listener.address();
      activePort = typeof address === "object" && address ? address.port : candidatePort;
      break;
    } catch (error) {
      lastError = error;
      if (!canRetryPort(error) || candidatePort === portCandidates[portCandidates.length - 1]) {
        throw error;
      }
    }
  }

  if (!listener) {
    throw lastError || new Error("Failed to start MCP HTTP server.");
  }

  if (activePort !== preferredPort) {
    console.warn(`Preferred MCP port ${preferredPort} unavailable, using ${activePort} instead.`);
  }
  console.log(`MCP Streamable HTTP server listening on http://${host}:${activePort}/mcp`);

  return {
    host,
    port: activePort,
    preferredPort,
    usedFallbackPort: activePort !== preferredPort,
    close() {
      return new Promise((resolve, reject) => {
        listener.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

module.exports = {
  startMcpHttpServer,
};
