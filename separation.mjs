import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./media.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demucsRoot = process.env.DEMUCS_ROOT || __dirname;
const demucsBinDirectory = process.platform === "win32" ? "Scripts" : "bin";
const demucsExecutable = process.platform === "win32" ? "demucs.exe" : "demucs";
const defaultDemucsBin = path.join(
  demucsRoot,
  ".venv-demucs",
  demucsBinDirectory,
  demucsExecutable,
);

export function getDemucsBin() {
  return process.env.DEMUCS_BIN || defaultDemucsBin;
}

export async function isDemucsAvailable() {
  try {
    await fs.access(getDemucsBin());
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
  return path.join(workDir, "htdemucs", "minus_vocals.wav");
}

export async function separateBackground(audioPath, workDir) {
  if (!(await isDemucsAvailable())) {
    throw new Error("清晰分离组件尚未准备好，请改用快速混音。");
  }

  await fs.mkdir(workDir, { recursive: true });
  await run(getDemucsBin(), [
    "-n",
    "htdemucs",
    "--two-stems",
    "vocals",
    "--other-method",
    "minus",
    "--shifts",
    "0",
    "-d",
    process.env.DEMUCS_DEVICE || "cpu",
    "-o",
    workDir,
    "--filename",
    "{stem}.{ext}",
    audioPath,
  ]);

  const backgroundPath = getSeparatedBackgroundPath(workDir);
  await fs.access(backgroundPath);
  return backgroundPath;
}
