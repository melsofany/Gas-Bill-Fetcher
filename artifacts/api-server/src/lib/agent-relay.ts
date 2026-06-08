import { WebSocket } from "ws";
import { logger } from "./logger";

export interface InvoiceResult {
  accountNumber: string;
  consumption: string | null;
  creditAdjustment: string | null;
  advanceBalance: string | null;
  amount: string | null;
  issueMonth: string | null;
  status: "success" | "error" | "pending";
  error: string | null;
}

interface PendingTask {
  resolve: (result: Omit<InvoiceResult, "accountNumber">) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class AgentRelay {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingTask>();
  private connectedAt: string | null = null;

  registerAgent(ws: WebSocket) {
    if (this.socket) {
      logger.info("New agent connected — replacing previous one");
      this.socket.close();
    }

    this.socket = ws;
    this.connectedAt = new Date().toISOString();
    logger.info("Local agent connected");

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch (err) {
        logger.warn({ err }, "Bad message from agent");
      }
    });

    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
        this.connectedAt = null;
        logger.info("Local agent disconnected");
        for (const [taskId, task] of this.pending) {
          clearTimeout(task.timer);
          task.reject(new Error("الوكيل المحلي قطع الاتصال أثناء تنفيذ المهمة"));
          this.pending.delete(taskId);
        }
      }
    });

    ws.on("error", (err) => {
      logger.error({ err }, "Agent WebSocket error");
    });

    ws.send(JSON.stringify({ type: "ready" }));
  }

  private handleMessage(msg: Record<string, unknown>) {
    if (msg.type === "pong") return;

    if (msg.type === "scrape_result") {
      const taskId = msg.taskId as string;
      const task = this.pending.get(taskId);
      if (!task) return;
      clearTimeout(task.timer);
      this.pending.delete(taskId);
      task.resolve(msg.result as Omit<InvoiceResult, "accountNumber">);
      return;
    }

    if (msg.type === "scrape_error") {
      const taskId = msg.taskId as string;
      const task = this.pending.get(taskId);
      if (!task) return;
      clearTimeout(task.timer);
      this.pending.delete(taskId);
      task.reject(new Error(msg.message as string || "خطأ في الوكيل"));
      return;
    }
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  getStatus() {
    return {
      connected: this.isConnected(),
      connectedAt: this.connectedAt,
    };
  }

  scrapeAccount(
    taskId: string,
    account: string,
    timeoutMs = 120_000
  ): Promise<Omit<InvoiceResult, "accountNumber">> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error("لا يوجد وكيل محلي متصل"));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        reject(new Error(`انتهت مهلة استخراج الحساب ${account}`));
      }, timeoutMs);

      this.pending.set(taskId, { resolve, reject, timer });

      this.socket!.send(
        JSON.stringify({ type: "scrape", taskId, account }),
        (err) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(taskId);
            reject(err);
          }
        }
      );
    });
  }

  ping() {
    if (this.isConnected()) {
      this.socket!.send(JSON.stringify({ type: "ping" }));
    }
  }
}

export const agentRelay = new AgentRelay();
