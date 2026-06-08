import { Router, type IRouter } from "express";
import healthRouter from "./health";
import scraperRouter from "./scraper";
import agentRouter from "./agent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scraperRouter);
router.use(agentRouter);

export default router;
