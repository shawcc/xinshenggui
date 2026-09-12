import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFfmpegBin, getFfprobeBin, run } from "./media.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demucsRoot = process.env.DEMUCS_ROOT || __dirname;

function getBundledRuntime() {
  const manifest = JSON.parse(
    syncFs.readFileSync(
      path.join(demucsRoot, ".demucs-runtime.json"),
      "utf8",
    ),
  );
  const python = path.join(demucsRoot, manifest.python);
  return {
    python,
    sitePackages: path.join(demucsRoot, manifest.sitePackages),
    pythonHome: path.dirname(path.dirname(python)),
  };
}

export function getDemucsBin() {
  if (process.env.DEMUCS_BIN) return process.env.DEMUCS_BIN;
  return getBundledRuntime().python;
}

export async function isDemucsAvailable() {
  try {
    if (process.env.DEMUCS_BIN) {
      await fs.access(process.env.DEMUCS_BIN);
      return true;
    }
    const runtime = getBundledRuntime();
    await Promise.all([
      fs.access(runtime.python),
      fs.access(path.join(runtime.sitePackages, "demucs")),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function extractPrimaryAudio(videoPath, audioPath) {
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "2",
    "-ar",
    "44100",
    "-c:a",
    "pcm_s16le",
    audioPath,
  ]);
}

export function getSeparatedBackgroundPath(workDir) {
  return path.join(workDir, "htdemucs", "no_vocals.mp3");
}

function getDemucsEnvironment(runtime) {
  const ffmpegDir = path.dirname(getFfmpegBin());
  const ffprobeDir = path.dirname(getFfprobeBin());
  return {
    ...process.env,
    ...(runtime
      ? {
          PYTHONHOME: runtime.pythonHome,
          PYTHONPATH: runtime.sitePackages,
        }
      : {}),
    PATH: [ffmpegDir, ffprobeDir, process.env.PATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
}

export async function separateBackground(audioPath, workDir) {
  if (!(await isDemucsAvailable())) {
    throw new Error("清晰分离组件尚未准备好，请改用快速混音。");
  }

  await fs.mkdir(workDir, { recursive: true });
  const runtime = process.env.DEMUCS_BIN ? null : getBundledRuntime();
  await run(getDemucsBin(), [
    ...(runtime ? ["-m", "demucs"] : []),
    "-n",
    "htdemucs",
    "--two-stems",
    "vocals",
    "--shifts",
    "0",
    "--mp3",
    "--mp3-bitrate",
    "320",
    "-d",
    process.env.DEMUCS_DEVICE || "cpu",
    "-o",
    workDir,
    "--filename",
    "{stem}.{ext}",
    audioPath,
  ], {
    env: getDemucsEnvironment(runtime),
  });

  const backgroundPath = getSeparatedBackgroundPath(workDir);
  await fs.access(backgroundPath);
  return backgroundPath;
}
