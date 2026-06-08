import express, { type Express, type Request, type Response } from "express";
  import cors from "cors";
  import pinoHttp from "pino-http";
  import path from "path";
  import { fileURLToPath } from "url";
  import router from "./routes";
  import { logger } from "./lib/logger";

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

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
  const frontendDist = path.resolve(__dirname, "../../petrotrade-scraper/dist/public");
  app.use(express.static(frontendDist));

  // Catch-all: serve index.html for any non-API route (SPA routing)
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });

  export default app;
  