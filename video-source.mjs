import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getFfmpegBin, getFfprobeBin } from "./media.mjs";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export function normalizeYouTubeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("请输入有效的 YouTube 视频链接。");
  }

  if (parsed.protocol !== "https:" || !YOUTUBE_HOSTS.has(parsed.hostname)) {
    throw new Error("目前只支持 HTTPS YouTube 视频链接。");
  }
  if (
    parsed.hostname === "youtu.be" &&
    parsed.pathname.replaceAll("/", "").length === 0
  ) {
    throw new Error("这个 YouTube 链接中没有视频 ID。");
  }
  if (
    parsed.hostname !== "youtu.be" &&
    !parsed.searchParams.get("v") &&
    !/^\/(shorts|live|embed)\//.test(parsed.pathname)
  ) {
    throw new Error("这个 YouTube 链接中没有视频 ID。");
  }

  return parsed.toString();
}

export async function downloadYouTubeVideo({
  url,
  outputDir,
  uvBin = process.env.UV_PATH || "uv",
  onProgress = () => {},
}) {
  const normalizedUrl = normalizeYouTubeUrl(url);
  await fs.mkdir(outputDir, { recursive: true });
  const outputTemplate = path.join(outputDir, "source.%(ext)s");
  const ytDlpArgs = [
    "--ignore-config",
    "--ignore-errors",
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "--js-runtimes",
    `node:${process.env.YTDLP_NODE_PATH || process.execPath}`,
    "--progress",
    "--progress-template",
    "download:progress=%(progress._percent_str)s",
    "--print",
    "before_dl:title=%(title)s",
    "--print",
    "after_move:filepath=%(filepath)s",
    "--merge-output-format",
    "mkv",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en,zh-Hans,zh-Hant",
    "--embed-subs",
    "-f",
    "bv*[height<=1080]+ba/b[height<=1080]",
    "-o",
    outputTemplate,
    normalizedUrl,
  ];
  const command = process.env.YTDLP_BIN || uvBin;
  const args = process.env.YTDLP_BIN
    ? ytDlpArgs
    : [
    "tool",
    "run",
    "--python",
    "3.11",
    "--from",
    "yt-dlp",
    "yt-dlp",
    ...ytDlpArgs,
  ];

  const result = await runDownloader(command, args, {
    cwd: outputDir,
    onLine(line) {
      const match = line.match(/progress=\s*([\d.]+)%/);
      if (match) {
        onProgress(Math.max(1, Math.min(99, Math.round(Number(match[1])))));
      }
    },
  });
  const titleLine = result.lines.find((line) => line.startsWith("title="));
  const pathLine = result.lines.find((line) => line.startsWith("filepath="));
  const downloadedPath = pathLine?.slice("filepath=".length).trim();

  if (!downloadedPath) {
    throw new Error("YouTube 下载完成，但未找到视频文件。");
  }
  const resolvedOutput = path.resolve(downloadedPath);
  if (!resolvedOutput.startsWith(`${path.resolve(outputDir)}${path.sep}`)) {
    throw new Error("下载器返回了无效的视频路径。");
  }
  await fs.access(resolvedOutput);
  onProgress(100);

  return {
    path: resolvedOutput,
    title: titleLine?.slice("title=".length).trim() || path.basename(resolvedOutput),
  };
}

function runDownloader(command, args, { cwd, onLine }) {
  return new Promise((resolve, reject) => {
    const ffmpegDir = path.dirname(getFfmpegBin());
    const ffprobeDir = path.dirname(getFfprobeBin());
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PATH: [ffmpegDir, ffprobeDir, process.env.PATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let pending = "";
    const lines = [];

    child.stdout.on("data", (chunk) => {
      output += chunk;
      pending += chunk;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() || "";
      for (const line of parts) {
        lines.push(line);
        onLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-16000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (pending) {
        lines.push(pending);
        onLine(pending);
      }
      if (code === 0) {
        resolve({ lines });
        return;
      }
      reject(new Error(`${command} exited with ${code}\n${output}`));
    });
  });
}
