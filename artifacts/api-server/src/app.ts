import express, { type Express, type Request, type Response } from "express";
  import cors from "cors";
  import pinoHttp from "pino-http";
  import path from "path";
  import fs from "fs";
  import router from "./routes";
  import { logger } from "./lib/logger";

  const app: Express = express();

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use("/api", router);

  // Serve React frontend static files
  // start command: cd artifacts/api-server && node ./dist/index.mjs => cwd = artifacts/api-server
  const frontendDist = path.resolve(process.cwd(), "../petrotrade-scraper/dist/public");

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
    logger.info({ frontendDist }, "Serving frontend static files");
  } else {
    logger.warn({ frontendDist }, "Frontend dist not found, skipping static file serving");
    app.get("/", (_req: Request, res: Response) => {
      res.json({ status: "ok", message: "Gas Bill Fetcher API is running", endpoints: ["/api/healthz", "/api/agent/status", "/api/scraper/run"] });
    });
  }

  export default app;
  