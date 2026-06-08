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
          return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use("/api", router);

  app.get("/debug-paths", (_req: Request, res: Response) => {
    const cwd = process.cwd();
    const scraperDir = path.resolve(cwd, "../petrotrade-scraper");
    let scraperContents: string[] = [];
    let distContents: string[] = [];
    try { scraperContents = fs.readdirSync(scraperDir); } catch {}
    try { distContents = fs.readdirSync(path.join(scraperDir, "dist")); } catch {}
    res.json({
      cwd,
      scraperDir,
      scraperExists: fs.existsSync(scraperDir),
      scraperContents,
      distContents,
      frontendDist: path.join(scraperDir, "dist/public"),
      frontendDistExists: fs.existsSync(path.join(scraperDir, "dist/public")),
    });
  });

  const frontendDist = path.resolve(process.cwd(), "../petrotrade-scraper/dist/public");

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  } else {
    app.get("/", (_req: Request, res: Response) => {
      res.json({ status: "ok", message: "API running — frontend not found", frontendDist });
    });
  }

  export default app;
  