import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { muxDubbedTrack, muxMixedDubbedTrack, probeMedia } from "./media.mjs";
import {
  extractPrimaryAudio,
  isDemucsAvailable,
  separateBackground,
} from "./separation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storageDir = process.env.APP_DATA_PATH
  ? path.join(process.env.APP_DATA_PATH, "storage")
  : path.join(__dirname, "storage");
const uploadDir = path.join(storageDir, "uploads");
const outputDir = path.join(storageDir, "outputs");
const workDir = path.join(storageDir, "work");

await Promise.all([
  fs.mkdir(uploadDir, { recursive: true }),
  fs.mkdir(outputDir, { recursive: true }),
  fs.mkdir(workDir, { recursive: true }),
]);

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 },
});
const app = express();
const projects = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (_request, response) => {
  response.json({
    ok: true,
    ffmpeg: true,
    demucs: await isDemucsAvailable(),
    access: process.env.HOST === "0.0.0.0" ? "lan" : "local",
  });
});

app.post("/api/projects", upload.single("video"), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "请选择一个视频文件。" });
    return;
  }

  try {
    const media = await probeMedia(request.file.path);
    if (!media.video) {
      await fs.unlink(request.file.path);
      response.status(400).json({ error: "文件中没有检测到视频轨道。" });
      return;
    }

    const id = crypto.randomUUID();
    const project = {
      id,
      originalName: request.file.originalname,
      sourcePath: request.file.path,
      media,
      createdAt: new Date().toISOString(),
    };
    projects.set(id, project);
    response.json(toPublicProject(project));
  } catch (error) {
    await fs.unlink(request.file.path).catch(() => {});
    response.status(422).json({
      error: "无法读取这个视频，请确认文件没有损坏。",
      detail: error.message,
    });
  }
});

app.post(
  "/api/projects/:id/package",
  upload.single("audio"),
  async (request, response) => {
    const project = projects.get(request.params.id);
    if (!project) {
      response.status(404).json({ error: "项目已失效，请重新选择视频。" });
      return;
    }
    if (!request.file) {
      response.status(400).json({ error: "请选择配音文件。" });
      return;
    }

    const stem = path
      .parse(project.originalName)
      .name.replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .slice(0, 80);
    const outputName = `${stem}.中文配音双音轨.mkv`;
    const outputPath = path.join(outputDir, `${project.id}-${outputName}`);
    const projectWorkDir = path.join(workDir, project.id);
    const mixMode = request.body.mixMode === "quick" ? "quick" : "separate";

    try {
      let processing = "voice-only";
      if (project.media.audioTracks.length === 0) {
        await muxDubbedTrack({
          videoPath: project.sourcePath,
          audioPath: request.file.path,
          outputPath,
          originalAudioTracks: 0,
          duration: project.media.duration,
        });
      } else if (mixMode === "separate") {
        const extractedAudioPath = path.join(projectWorkDir, "original.wav");
        await fs.mkdir(projectWorkDir, { recursive: true });
        await extractPrimaryAudio(project.sourcePath, extractedAudioPath);
        const backgroundPath = await separateBackground(
          extractedAudioPath,
          path.join(projectWorkDir, "separated"),
        );
        await muxMixedDubbedTrack({
          videoPath: project.sourcePath,
          audioPath: request.file.path,
          backgroundPath,
          outputPath,
          originalAudioTracks: project.media.audioTracks.length,
          duration: project.media.duration,
        });
        processing = "demucs";
      } else {
        await muxMixedDubbedTrack({
          videoPath: project.sourcePath,
          audioPath: request.file.path,
          outputPath,
          originalAudioTracks: project.media.audioTracks.length,
          duration: project.media.duration,
        });
        processing = "quick";
      }
      await fs.unlink(request.file.path).catch(() => {});
      await fs.rm(projectWorkDir, { recursive: true, force: true });
      project.outputName = outputName;
      project.outputPath = outputPath;
      project.processing = processing;
      response.json({
        ...toPublicProject(project),
        downloadUrl: `/api/projects/${project.id}/download`,
      });
    } catch (error) {
      await fs.unlink(request.file.path).catch(() => {});
      await fs.rm(projectWorkDir, { recursive: true, force: true });
      response.status(422).json({
        error:
          mixMode === "separate"
            ? "背景声分离失败，可改用快速混音再试。"
            : "音轨混音失败，请检查配音文件是否有效。",
        detail: error.message,
      });
    }
  },
);

app.get("/api/projects/:id/download", (request, response) => {
  const project = projects.get(request.params.id);
  if (!project?.outputPath) {
    response.status(404).json({ error: "还没有生成可下载的文件。" });
    return;
  }
  response.download(project.outputPath, project.outputName);
});

app.get("*path", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "index.html"));
});

function toPublicProject(project) {
  return {
    id: project.id,
    originalName: project.originalName,
    media: project.media,
    createdAt: project.createdAt,
    outputName: project.outputName,
    processing: project.processing,
  };
}

export async function startServer({
  port = Number(process.env.PORT || 4173),
  host = process.env.HOST || "127.0.0.1",
} = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const resolvedPort =
        typeof address === "object" && address ? address.port : port;
      const accessLabel = host === "0.0.0.0" ? "局域网" : "仅本机";
      console.log(`新声轨已启动：http://localhost:${resolvedPort}（${accessLabel}）`);
      resolve({ server, port: resolvedPort, host, storageDir, outputDir });
    });
  });
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
