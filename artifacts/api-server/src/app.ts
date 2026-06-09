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

  const frontendDist = path.resolve(process.cwd(), "../petrotrade-scraper/dist/public");

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    // Express 5 requires named wildcards — "/*path" catches all remaining routes for SPA
    app.get("/*path", (_req: Request, res: Response) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  } else {
    app.get("/", (_req: Request, res: Response) => {
      res.json({ status: "ok", message: "API running — frontend not built", frontendDist });
    });
  }

  export default app;
  