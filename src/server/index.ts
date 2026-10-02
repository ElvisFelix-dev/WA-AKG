import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { Server } from "socket.io";

import { setupSocket } from "./socket";
import { waManager } from "../modules/whatsapp/manager";
import { logger } from "../lib/logger";

import pkg from "../../package.json";

const dev = process.env.NODE_ENV !== "production";

const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

if (!process.env.AUTH_SECRET) {
  logger.error(
    "Server",
    "AUTH_SECRET is not set. Generate one with: openssl rand -base64 32"
  );

  process.exit(1);
}

const app = next({
  dev,
  hostname,
  port,
});

const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.statusCode = 400;
        res.end("Bad Request");
        return;
      }

      const parsedUrl = parse(req.url, true);

      await handle(req, res, parsedUrl);
    } catch (error) {
      logger.error(
        "Server",
        "Error handling request",
        req.url,
        error
      );

      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  // ============================================================
  // Socket.IO
  // ============================================================

  const io = new Server(server, {
    path: "/api/socket/io",

    addTrailingSlash: false,

    cors: {
      origin: process.env.FRONTEND_URL || "*",
      methods: ["GET", "POST"],
    },
  });

  setupSocket(io);

  // Global instance for modules that need Socket.IO
  (global as any).io = io;

  // ============================================================
  // Keep Alive
  // ============================================================

  server.keepAliveTimeout = 120 * 1000;
  server.headersTimeout = 120 * 1000;

  // ============================================================
  // Start Server
  // ============================================================

  server.listen(port, async () => {
    logger.banner(
      pkg.name.toUpperCase(),
      pkg.version,
      port
    );

    // ==========================================================
    // WhatsApp Manager
    // ==========================================================

    try {
      waManager.setup(io);

      await waManager.loadSessions();

      logger.info(
        "WhatsApp",
        "WhatsApp Manager initialized"
      );
    } catch (error) {
      logger.error(
        "WhatsApp",
        "Failed to initialize WhatsApp Manager",
        undefined,
        error
      );
    }

    // ==========================================================
    // Scheduler
    // ==========================================================

    try {
      const { startScheduler } = await import(
        "../modules/whatsapp/scheduler"
      );

      startScheduler();

      logger.info(
        "WhatsApp",
        "Scheduler started"
      );
    } catch (error) {
      logger.error(
        "WhatsApp",
        "Failed to start scheduler",
        undefined,
        error
      );
    }

    // ==========================================================
    // Optional Monitoring
    // ==========================================================

    if (
      process.env.ENABLE_HEARTBEAT === "true" &&
      process.env.MONITOR_URL
    ) {
      const monitorUrl = process.env.MONITOR_URL;

      const appUrl =
        process.env.BASE_URL ||
        `http://${hostname}:${port}`;

      const appName =
        process.env.APP_NAME || pkg.name;

      const sendHeartbeat = async () => {
        try {
          await fetch(monitorUrl, {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
            },

            body: JSON.stringify({
              appUrl,
              appName,
              isBackend: true,

              systemInfo: {
                platform: process.platform,
                nodeVersion: process.version,
                memoryUsage:
                  Math.round(
                    process.memoryUsage().rss /
                      1024 /
                      1024
                  ) + "MB",
              },
            }),
          });
        } catch {
          // Monitoring must never affect the application.
        }
      };

      await sendHeartbeat();

      setInterval(
        sendHeartbeat,
        30_000
      );

      logger.info(
        "Monitoring",
        "Heartbeat enabled"
      );
    }
  });
});