import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { app, BrowserWindow, session, shell } from "electron";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

let server;

function createWindow(port) {
  const window = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: "#f6f4ed",
    title: "新声轨",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  window.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(async () => {
  const dataPath = app.getPath("userData");
  process.env.APP_DATA_PATH = dataPath;
  process.env.DEMUCS_ROOT = app.isPackaged ? process.resourcesPath : projectRoot;
  process.env.FFMPEG_PATH = ffmpegPath;
  process.env.FFPROBE_PATH = ffprobeStatic.path;

  const { startServer } = await import("../server.mjs");
  const started = await startServer({ host: "127.0.0.1", port: 0 });
  server = started.server;
  const outputPath = path.join(app.getPath("videos"), "新声轨");
  await fs.mkdir(outputPath, { recursive: true });

  session.defaultSession.on("will-download", (_event, item) => {
    item.setSavePath(path.join(outputPath, item.getFilename()));
  });

  createWindow(started.port);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(started.port);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  server?.close();
});
