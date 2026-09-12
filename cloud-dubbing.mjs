import fs from "node:fs/promises";
import path from "node:path";
import { probeMedia, run } from "./media.mjs";

const CHUNK_SECONDS = 20 * 60;
const TRANSLATION_BATCH_SIZE = 36;
const TTS_CONCURRENCY = 3;

function endpoint(settings, pathname) {
  return `${settings.baseUrl.replace(/\/+$/, "")}${pathname}`;
}

async function readApiError(response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    return parsed.error?.message || parsed.error || body;
  } catch {
    return body || `HTTP ${response.status}`;
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return response.json();
}

function authHeaders(settings, extra = {}) {
  return {
    Authorization: `Bearer ${settings.apiKey}`,
    ...extra,
  };
}

export async function extractSpeechChunks(videoPath, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const pattern = path.join(outputDir, "speech-%03d.mp3");
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    "-f",
    "segment",
    "-segment_time",
    String(CHUNK_SECONDS),
    "-reset_timestamps",
    "1",
    pattern,
  ]);

  const names = (await fs.readdir(outputDir))
    .filter((name) => /^speech-\d+\.mp3$/.test(name))
    .sort();
  if (names.length === 0) {
    throw new Error("视频中没有可识别的声音。");
  }
  return names.map((name) => path.join(outputDir, name));
}

export function normalizeTranscriptionSegments(data, offset, duration) {
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    return data.segments
      .filter((segment) => String(segment.text || "").trim())
      .map((segment, index) => ({
        id: `${offset}-${segment.id ?? index}`,
        start: offset + Math.max(0, Number(segment.start || 0)),
        end: offset + Math.max(Number(segment.end || 0), Number(segment.start || 0) + 0.2),
        source: String(segment.text).trim(),
      }));
  }

  const text = String(data.text || "").trim();
  return text
    ? [{ id: `${offset}-0`, start: offset, end: offset + duration, source: text }]
    : [];
}

async function transcribeChunk(filePath, offset, settings) {
  const media = await probeMedia(filePath);
  const body = new FormData();
  body.append("model", settings.transcriptionModel);
  body.append("response_format", "verbose_json");
  body.append("timestamp_granularities[]", "segment");
  body.append(
    "file",
    new Blob([await fs.readFile(filePath)], { type: "audio/mpeg" }),
    path.basename(filePath),
  );

  const data = await requestJson(
    endpoint(settings, "/audio/transcriptions"),
    {
      method: "POST",
      headers: authHeaders(settings),
      body,
    },
  );

  return {
    duration: media.duration,
    language: data.language || "auto",
    segments: normalizeTranscriptionSegments(data, offset, media.duration),
  };
}

export async function transcribeVideo({
  videoPath,
  workDir,
  settings,
  onProgress = () => {},
}) {
  const chunks = await extractSpeechChunks(videoPath, workDir);
  const segments = [];
  let language = "auto";
  let offset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const result = await transcribeChunk(chunks[index], offset, settings);
    language = result.language || language;
    segments.push(...result.segments);
    offset += result.duration;
    onProgress((index + 1) / chunks.length);
  }

  if (segments.length === 0) {
    throw new Error("没有识别到可配音的对白。");
  }
  return { language, segments };
}

function parseTranslationResponse(data) {
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("翻译服务没有返回内容。");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.translations)) {
    throw new Error("翻译服务返回格式不正确。");
  }
  return new Map(
    parsed.translations.map((item) => [
      String(item.id),
      String(item.text || "").trim(),
    ]),
  );
}

async function translateBatch(batch, settings) {
  const payload = {
    model: settings.translationModel,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You translate spoken dialogue into concise, natural Simplified Chinese for dubbing. Preserve meaning and tone, avoid explanations, and keep each translation short enough for its source timing. Return JSON only as {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}]}.",
      },
      {
        role: "user",
        content: JSON.stringify({
          segments: batch.map(({ id, source, start, end }) => ({
            id,
            source,
            seconds: Number((end - start).toFixed(2)),
          })),
        }),
      },
    ],
  };

  const data = await requestJson(endpoint(settings, "/chat/completions"), {
    method: "POST",
    headers: authHeaders(settings, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return parseTranslationResponse(data);
}

export async function translateSegments({
  segments,
  settings,
  onProgress = () => {},
}) {
  const translated = [];
  for (let index = 0; index < segments.length; index += TRANSLATION_BATCH_SIZE) {
    const batch = segments.slice(index, index + TRANSLATION_BATCH_SIZE);
    const translations = await translateBatch(batch, settings);
    for (const segment of batch) {
      const text = translations.get(String(segment.id));
      if (!text) {
        throw new Error(`翻译结果缺少片段 ${segment.id}。`);
      }
      translated.push({ ...segment, text });
    }
    onProgress(Math.min(1, (index + batch.length) / segments.length));
  }
  return translated;
}

async function synthesizeSegment(segment, index, outputDir, settings, voice) {
  const response = await fetch(endpoint(settings, "/audio/speech"), {
    method: "POST",
    headers: authHeaders(settings, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: settings.speechModel,
      voice,
      input: segment.text,
      response_format: "mp3",
    }),
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const outputPath = path.join(
    outputDir,
    `voice-${String(index).padStart(4, "0")}.mp3`,
  );
  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return { ...segment, audioPath: outputPath };
}

async function mapConcurrent(items, concurrency, operation, onProgress) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index], index);
      completed += 1;
      onProgress(completed / items.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

export async function synthesizeSegments({
  segments,
  workDir,
  settings,
  voice = "coral",
  onProgress = () => {},
}) {
  await fs.mkdir(workDir, { recursive: true });
  return mapConcurrent(
    segments,
    TTS_CONCURRENCY,
    (segment, index) =>
      synthesizeSegment(segment, index, workDir, settings, voice),
    onProgress,
  );
}

function atempoFilters(ratio) {
  const filters = [];
  let remaining = ratio;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  if (remaining > 1.005) filters.push(`atempo=${remaining.toFixed(5)}`);
  return filters;
}

export async function createAlignedDubTrack({
  segments,
  duration,
  outputPath,
}) {
  if (segments.length === 0) {
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      String(duration),
      "-c:a",
      "pcm_s16le",
      outputPath,
    ]);
    return;
  }

  const args = ["-y"];
  for (const segment of segments) args.push("-i", segment.audioPath);

  const filters = [];
  const labels = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const media = await probeMedia(segment.audioPath);
    const slot = Math.max(0.2, segment.end - segment.start);
    const ratio = media.duration > slot ? media.duration / slot : 1;
    const chain = [
      "aresample=48000",
      ...atempoFilters(ratio),
      `apad=whole_dur=${slot.toFixed(3)}`,
      `atrim=duration=${slot.toFixed(3)}`,
      `adelay=delays=${Math.round(segment.start * 1000)}:all=1`,
    ];
    const label = `voice${index}`;
    filters.push(`[${index}:a]${chain.join(",")}[${label}]`);
    labels.push(`[${label}]`);
  }

  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95,apad=whole_dur=${duration.toFixed(3)},atrim=duration=${duration.toFixed(3)}[dub]`,
  );
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[dub]",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    outputPath,
  );
  await run("ffmpeg", args);
}

function srtTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function buildSrt(segments) {
  return `${segments
    .map(
      (segment, index) =>
        `${index + 1}\n${srtTimestamp(segment.start)} --> ${srtTimestamp(segment.end)}\n${segment.text.replace(/\r?\n/g, " ")}\n`,
    )
    .join("\n")}\n`;
}

export async function generateCloudDub({
  videoPath,
  workDir,
  duration,
  settings,
  voice,
  onProgress = () => {},
}) {
  onProgress(5, "正在提取原片对白");
  const transcription = await transcribeVideo({
    videoPath,
    workDir: path.join(workDir, "speech"),
    settings,
    onProgress(value) {
      onProgress(8 + Math.round(value * 24), "正在识别外语对白");
    },
  });

  const translated = await translateSegments({
    segments: transcription.segments,
    settings,
    onProgress(value) {
      onProgress(34 + Math.round(value * 16), "正在翻译成中文");
    },
  });

  const voiced = await synthesizeSegments({
    segments: translated,
    workDir: path.join(workDir, "voice"),
    settings,
    voice,
    onProgress(value) {
      onProgress(52 + Math.round(value * 28), "正在生成中文语音");
    },
  });

  onProgress(82, "正在对齐中文对白");
  const audioPath = path.join(workDir, "generated-dub.wav");
  await createAlignedDubTrack({ segments: voiced, duration, outputPath: audioPath });

  const subtitlePath = path.join(workDir, "generated-zh.srt");
  await fs.writeFile(subtitlePath, buildSrt(translated));
  onProgress(88, "中文音轨已生成");

  return {
    audioPath,
    subtitlePath,
    language: transcription.language,
    segmentCount: translated.length,
  };
}
