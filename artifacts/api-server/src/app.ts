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

  // Debug endpoint to diagnose path issues on Render
  app.get("/debug-paths", (_req: Request, res: Response) => {
    const cwd = process.cwd();
    const candidate = path.resolve(cwd, "../petrotrade-scraper/dist/public");
    const candidateAlt = path.resolve(cwd, "../../artifacts/petrotrade-scraper/dist/public");
    
    let cwdList: string[] = [];
    let parentList: string[] = [];
    try { cwdList = fs.readdirSync(cwd); } catch {}
    try { parentList = fs.readdirSync(path.resolve(cwd, "..")); } catch {}

    res.json({
      cwd,
      candidate,
      candidateExists: fs.existsSync(candidate),
      candidateAlt,
      candidateAltExists: fs.existsSync(candidateAlt),
      cwdContents: cwdList,
      parentContents: parentList,
    });
  });

  // Serve React frontend static files
  const frontendDist = path.resolve(process.cwd(), "../petrotrade-scraper/dist/public");

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  } else {
    app.get("/", (_req: Request, res: Response) => {
      res.json({ status: "ok", message: "Gas Bill Fetcher API — frontend not found at: " + frontendDist });
    });
  }

  export default app;
  