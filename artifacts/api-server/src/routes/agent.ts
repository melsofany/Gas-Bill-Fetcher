import { Router, type IRouter, type Request, type Response } from "express";
import { agentRelay } from "../lib/agent-relay";

const router: IRouter = Router();

router.get("/agent/status", (_req: Request, res: Response) => {
  res.json(agentRelay.getStatus());
});

export default router;
