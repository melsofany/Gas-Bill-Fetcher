import { createServer } from "http";
import { WebSocketServer } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { agentRelay } from "./lib/agent-relay";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);

const wss = new WebSocketServer({ server, path: "/api/agent/ws" });

wss.on("connection", (ws) => {
  agentRelay.registerAgent(ws);
});

setInterval(() => agentRelay.ping(), 30_000);

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
