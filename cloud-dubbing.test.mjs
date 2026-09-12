import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  buildSrt,
  generateCloudDub,
  normalizeTranscriptionSegments,
} from "./cloud-dubbing.mjs";
import { probeMedia, run } from "./media.mjs";

const root = new URL("./storage/cloud-test/", import.meta.url).pathname;
const sourcePath = path.join(root, "source.mkv");
const voicePath = path.join(root, "voice.mp3");
const workDir = path.join(root, "work");
let server;
let baseUrl;

before(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=320x180:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    sourcePath,
  ]);
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:duration=0.35",
    "-b:a",
    "64k",
    voicePath,
  ]);
  const voice = await fs.readFile(voicePath);

  server = http.createServer(async (request, response) => {
    if (request.url === "/v1/audio/transcriptions") {
      for await (const _chunk of request) {
        // Drain the multipart upload before responding.
      }
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          language: "english",
          text: "Hello. Welcome.",
          segments: [
            { id: 0, start: 0.2, end: 1.1, text: "Hello." },
            { id: 1, start: 1.4, end: 2.5, text: "Welcome." },
          ],
        }),
      );
      return;
    }

    if (request.url === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const input = JSON.parse(payload.messages[1].content);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: input.segments.map((segment, index) => ({
                    id: segment.id,
                    text: index === 0 ? "你好。" : "欢迎。",
                  })),
                }),
              },
            },
          ],
        }),
      );
      return;
    }

    if (request.url === "/v1/audio/speech") {
      for await (const _chunk of request) {
        // Drain the JSON request before responding.
      }
      response.setHeader("Content-Type", "audio/mpeg");
      response.end(voice);
      return;
    }

    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

test("normalizes timestamped transcription segments", () => {
  const segments = normalizeTranscriptionSegments(
    {
      segments: [{ id: 4, start: 0.5, end: 1.2, text: " Hello " }],
    },
    120,
    10,
  );
  assert.deepEqual(segments, [
    { id: "120-4", start: 120.5, end: 121.2, source: "Hello" },
  ]);
});

test("buildSrt creates aligned Simplified Chinese captions", () => {
  const srt = buildSrt([
    { start: 1.25, end: 2.8, text: "你好。" },
  ]);
  assert.match(srt, /00:00:01,250 --> 00:00:02,800/);
  assert.match(srt, /你好。/);
});

test("cloud dubbing produces an aligned track and subtitle", async () => {
  const result = await generateCloudDub({
    videoPath: sourcePath,
    workDir,
    duration: 3,
    voice: "coral",
    settings: {
      baseUrl,
      apiKey: "test-key",
      transcriptionModel: "whisper-1",
      translationModel: "test-translation",
      speechModel: "test-speech",
    },
  });

  const media = await probeMedia(result.audioPath);
  assert.equal(result.language, "english");
  assert.equal(result.segmentCount, 2);
  assert.equal(media.audioTracks.length, 1);
  assert.ok(media.duration >= 2.9 && media.duration <= 3.1);
  assert.match(await fs.readFile(result.subtitlePath, "utf8"), /欢迎。/);
});
