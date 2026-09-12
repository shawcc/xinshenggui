import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

export function getFfmpegBin() {
  return process.env.FFMPEG_PATH || ffmpegPath || "ffmpeg";
}

function getFfprobeBin() {
  return process.env.FFPROBE_PATH || ffprobeStatic.path || "ffprobe";
}

function resolveCommand(command) {
  if (command === "ffmpeg") return getFfmpegBin();
  if (command === "ffprobe") return getFfprobeBin();
  return command;
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const resolvedCommand = resolveCommand(command);
    const child = spawn(resolvedCommand, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const output = [stdout, stderr].filter(Boolean).join("\n");
      reject(new Error(`${resolvedCommand} exited with ${code}\n${output}`));
    });
  });
}

export async function probeMedia(filePath) {
  const { stdout } = await run(getFfprobeBin(), [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=index,codec_type,codec_name,width,height,channels",
    "-of",
    "json",
    filePath,
  ]);

  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audioTracks =
    data.streams?.filter((stream) => stream.codec_type === "audio") ?? [];

  return {
    duration: Number(data.format?.duration ?? 0),
    size: Number(data.format?.size ?? 0),
    video: video
      ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
        }
      : null,
    audioTracks: audioTracks.map((track) => ({
      codec: track.codec_name,
      channels: track.channels,
    })),
  };
}

function trackDispositionArgs(originalAudioTracks, dubbedTrackIndex) {
  const args = [];
  for (let index = 0; index < originalAudioTracks; index += 1) {
    args.push(`-disposition:a:${index}`, "0");
  }
  args.push(`-disposition:a:${dubbedTrackIndex}`, "default");
  return args;
}

function dubbedTrackArgs({ dubbedTrackIndex, duration, outputPath }) {
  return [
    "-c",
    "copy",
    `-c:a:${dubbedTrackIndex}`,
    "aac",
    `-b:a:${dubbedTrackIndex}`,
    "192k",
    `-metadata:s:a:${dubbedTrackIndex}`,
    "language=chi",
    `-metadata:s:a:${dubbedTrackIndex}`,
    "title=中文配音",
    "-t",
    String(duration),
    outputPath,
  ];
}

export function buildMuxArgs({
  videoPath,
  audioPath,
  outputPath,
  originalAudioTracks,
  duration,
}) {
  const dubbedTrackIndex = originalAudioTracks;
  return [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
    "-map",
    "1:a:0",
    ...trackDispositionArgs(originalAudioTracks, dubbedTrackIndex),
    ...dubbedTrackArgs({ dubbedTrackIndex, duration, outputPath }),
  ];
}

export async function muxDubbedTrack(options) {
  return run(getFfmpegBin(), buildMuxArgs(options));
}

export function buildMixedMuxArgs({
  videoPath,
  audioPath,
  backgroundPath,
  outputPath,
  originalAudioTracks,
  duration,
}) {
  const dubbedTrackIndex = originalAudioTracks;
  const hasSeparatedBackground = Boolean(backgroundPath);
  const args = ["-y", "-i", videoPath];

  if (hasSeparatedBackground) {
    args.push("-i", backgroundPath, "-i", audioPath);
  } else {
    args.push("-i", audioPath);
  }

  const backgroundInput = hasSeparatedBackground ? "1:a:0" : "0:a:0";
  const dubbedInput = hasSeparatedBackground ? "2:a:0" : "1:a:0";
  const backgroundVolume = hasSeparatedBackground ? "0.95" : "0.12";
  const filter = [
    `[${backgroundInput}]volume=${backgroundVolume}[background]`,
    `[${dubbedInput}]volume=1.25[dubbed]`,
    "[background][dubbed]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.95[mixed]",
  ].join(";");

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
    "-map",
    "[mixed]",
    ...trackDispositionArgs(originalAudioTracks, dubbedTrackIndex),
    ...dubbedTrackArgs({ dubbedTrackIndex, duration, outputPath }),
  );

  return args;
}

export async function muxMixedDubbedTrack(options) {
  return run(getFfmpegBin(), buildMixedMuxArgs(options));
}
