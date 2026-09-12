import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import {
  loadAiSettings,
  saveAiSettings,
  toPublicAiSettings,
} from "./ai-settings.mjs";
import { generateCloudDub } from "./cloud-dubbing.mjs";
import { muxDubbedTrack, muxMixedDubbedTrack, probeMedia } from "./media.mjs";
import {
  extractPrimaryAudio,
  isDemucsAvailable,
  separateBackground,
} from "./separation.mjs";
import { setupDemucs } from "./scripts/setup-demucs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demucsRoot = process.env.DEMUCS_ROOT || __dirname;
const storageDir = process.env.APP_DATA_PATH
  ? path.join(process.env.APP_DATA_PATH, "storage")
  : path.join(__dirname, "storage");
const uploadDir = path.join(storageDir, "uploads");
const outputDir = path.join(storageDir, "outputs");
const workDir = path.join(storageDir, "work");
const settingsRoot = process.env.APP_DATA_PATH || storageDir;

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
const demucsInstallState = {
  status: "idle",
  progress: 0,
  message: "",
};
let demucsInstallPromise = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (_request, response) => {
  const [demucs, aiSettings] = await Promise.all([
    isDemucsAvailable(),
    loadAiSettings(settingsRoot),
  ]);
  response.json({
    ok: true,
    ffmpeg: true,
    demucs,
    demucsInstall: demucs
      ? { status: "ready", progress: 100, message: "清晰分离组件已就绪" }
      : demucsInstallState,
    ai: toPublicAiSettings(aiSettings),
    access: process.env.HOST === "0.0.0.0" ? "lan" : "local",
  });
});

app.get("/api/settings/ai", async (_request, response) => {
  response.json(toPublicAiSettings(await loadAiSettings(settingsRoot)));
});

app.put("/api/settings/ai", async (request, response) => {
  try {
    const settings = await saveAiSettings(settingsRoot, request.body);
    response.json(toPublicAiSettings(settings));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/runtime/demucs/install", async (_request, response) => {
  if (await isDemucsAvailable()) {
    response.json({
      demucs: true,
      status: "ready",
      progress: 100,
      message: "清晰分离组件已就绪",
    });
    return;
  }

  if (!demucsInstallPromise) {
    demucsInstallPromise = setupDemucs({
      root: demucsRoot,
      uvBin: process.env.UV_PATH || "uv",
      onProgress(progress, message) {
        Object.assign(demucsInstallState, {
          status: "installing",
          progress,
          message,
        });
      },
    })
      .then(() => {
        Object.assign(demucsInstallState, {
          status: "ready",
          progress: 100,
          message: "清晰分离组件已就绪",
        });
      })
      .catch((error) => {
        Object.assign(demucsInstallState, {
          status: "failed",
          progress: 0,
          message: "组件下载失败，可以重新尝试",
        });
        throw error;
      })
      .finally(() => {
        demucsInstallPromise = null;
      });
  }

  try {
    await demucsInstallPromise;
    response.json({ demucs: true, ...demucsInstallState });
  } catch (error) {
    response.status(502).json({
      error: "清晰分离组件下载失败，请检查网络后重试。",
      detail: error.message,
    });
  }
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
      job: { status: "idle", progress: 0, message: "" },
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

app.get("/api/projects/:id/status", (request, response) => {
  const project = projects.get(request.params.id);
  if (!project) {
    response.status(404).json({ error: "项目已失效，请重新选择视频。" });
    return;
  }
  response.json({
    ...project.job,
    ...(project.outputPath
      ? {
          outputName: project.outputName,
          processing: project.processing,
          downloadUrl: `/api/projects/${project.id}/download`,
        }
      : {}),
  });
});

app.post("/api/projects/:id/generate", async (request, response) => {
  const project = projects.get(request.params.id);
  if (!project) {
    response.status(404).json({ error: "项目已失效，请重新选择视频。" });
    return;
  }
  if (project.media.audioTracks.length === 0) {
    response.status(400).json({ error: "视频中没有可识别的原始音轨。" });
    return;
  }
  if (project.job.status === "processing") {
    response.status(202).json(project.job);
    return;
  }

  const settings = await loadAiSettings(settingsRoot);
  if (!settings.apiKey) {
    response.status(400).json({ error: "请先连接云端 AI 服务。" });
    return;
  }

  const mixMode = request.body.mixMode === "quick" ? "quick" : "separate";
  const allowedVoices = new Set(["coral", "alloy", "sage", "verse"]);
  const voice = allowedVoices.has(request.body.voice)
    ? request.body.voice
    : "coral";
  const projectWorkDir = path.join(workDir, project.id);

  project.job = {
    status: "processing",
    progress: 1,
    message: "正在准备自动配音",
  };
  project.jobPromise = (async () => {
    try {
      await fs.mkdir(projectWorkDir, { recursive: true });
      const generated = await generateCloudDub({
        videoPath: project.sourcePath,
        workDir: path.join(projectWorkDir, "generated"),
        duration: project.media.duration,
        settings,
        voice,
        onProgress(progress, message) {
          project.job = { status: "processing", progress, message };
        },
      });

      project.job = {
        status: "processing",
        progress: 90,
        message:
          mixMode === "separate" ? "正在分离背景声音" : "正在混合背景声音",
      };
      await packageProject({
        project,
        audioPath: generated.audioPath,
        subtitlePath: generated.subtitlePath,
        mixMode,
        outputSuffix: "中文AI配音双音轨",
      });
      project.generation = {
        sourceLanguage: generated.language,
        segmentCount: generated.segmentCount,
      };
      project.job = {
        status: "ready",
        progress: 100,
        message: "中文配音视频已生成",
      };
    } catch (error) {
      console.error("自动配音失败", error);
      project.job = {
        status: "failed",
        progress: 0,
        message: cloudErrorMessage(error),
      };
    } finally {
      await fs.rm(projectWorkDir, { recursive: true, force: true });
      project.jobPromise = null;
    }
  })();

  response.status(202).json(project.job);
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

    const projectWorkDir = path.join(workDir, project.id);
    const mixMode = request.body.mixMode === "quick" ? "quick" : "separate";

    try {
      await packageProject({
        project,
        audioPath: request.file.path,
        mixMode,
        outputSuffix: "中文配音双音轨",
      });
      await fs.unlink(request.file.path).catch(() => {});
      await fs.rm(projectWorkDir, { recursive: true, force: true });
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
    job: project.job,
  };
}

async function packageProject({
  project,
  audioPath,
  subtitlePath,
  mixMode,
  outputSuffix,
}) {
  const stem = path
    .parse(project.originalName)
    .name.replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .slice(0, 80);
  const outputName = `${stem}.${outputSuffix}.mkv`;
  const outputPath = path.join(outputDir, `${project.id}-${outputName}`);
  const projectWorkDir = path.join(workDir, project.id);
  const common = {
    videoPath: project.sourcePath,
    audioPath,
    subtitlePath,
    outputPath,
    originalAudioTracks: project.media.audioTracks.length,
    originalSubtitleTracks: project.media.subtitleTracks.length,
    duration: project.media.duration,
  };

  let processing = "voice-only";
  if (project.media.audioTracks.length === 0) {
    await muxDubbedTrack(common);
  } else if (mixMode === "separate") {
    if (!(await isDemucsAvailable())) {
      throw new Error("清晰分离组件尚未准备好。");
    }
    const extractedAudioPath = path.join(projectWorkDir, "original.wav");
    await fs.mkdir(projectWorkDir, { recursive: true });
    await extractPrimaryAudio(project.sourcePath, extractedAudioPath);
    const backgroundPath = await separateBackground(
      extractedAudioPath,
      path.join(projectWorkDir, "separated"),
    );
    await muxMixedDubbedTrack({ ...common, backgroundPath });
    processing = subtitlePath ? "demucs-ai" : "demucs";
  } else {
    await muxMixedDubbedTrack(common);
    processing = subtitlePath ? "quick-ai" : "quick";
  }

  project.outputName = outputName;
  project.outputPath = outputPath;
  project.processing = processing;
}

function cloudErrorMessage(error) {
  const message = String(error?.message || "");
  if (/\b401\b|api key|unauthorized|authentication/i.test(message)) {
    return "AI 服务认证失败，请检查 API Key。";
  }
  if (/fetch failed|ENOTFOUND|ECONN|network/i.test(message)) {
    return "无法连接 AI 服务，请检查网络或服务地址。";
  }
  if (/清晰分离组件/.test(message)) return message;
  return `自动配音失败：${message.slice(0, 180) || "请稍后重试。"}`;
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
