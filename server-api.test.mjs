import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { probeMedia, run } from "./media.mjs";

let root;
let sourcePath;
let cloudServer;
let appServer;
let cloudBaseUrl;
let appBaseUrl;
let mockDownloader;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xinshenggui-api-"));
  sourcePath = path.join(root, "source.mkv");
  const voicePath = path.join(root, "voice.mp3");
  mockDownloader = path.join(root, "mock-yt-dlp");

  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=320x180:d=1.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.5",
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
    "sine=frequency=660:duration=0.4",
    "-b:a",
    "64k",
    voicePath,
  ]);
  const voice = await fs.readFile(voicePath);
  await fs.writeFile(
    mockDownloader,
    [
      "#!/bin/sh",
      'cp "$MOCK_VIDEO_SOURCE" "$PWD/source.mkv"',
      "printf 'title=Imported video\\n'",
      "printf 'progress=75.0%%\\n'",
      "printf 'filepath=%s/source.mkv\\n' \"$PWD\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  cloudServer = http.createServer(async (request, response) => {
    let body = Buffer.alloc(0);
    for await (const chunk of request) {
      body = Buffer.concat([body, chunk]);
    }

    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/audio/transcriptions") {
      response.end(
        JSON.stringify({
          language: "english",
          segments: [{ id: 0, start: 0.1, end: 1.2, text: "Hello." }],
        }),
      );
      return;
    }
    if (request.url === "/v1/chat/completions") {
      const payload = JSON.parse(body.toString());
      const input = JSON.parse(payload.messages[1].content);
      response.end(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                translations: input.segments.map((segment) => ({
                  id: segment.id,
                  text: "你好。",
                })),
              }),
            },
          }],
        }),
      );
      return;
    }
    if (request.url === "/v1/audio/speech") {
      response.setHeader("Content-Type", "audio/mpeg");
      response.end(voice);
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) =>
    cloudServer.listen(0, "127.0.0.1", resolve),
  );
  cloudBaseUrl = `http://127.0.0.1:${cloudServer.address().port}/v1`;

  process.env.APP_DATA_PATH = root;
  process.env.MOCK_VIDEO_SOURCE = sourcePath;
  process.env.YTDLP_BIN = mockDownloader;
  const { startServer } = await import("./server.mjs");
  const started = await startServer({ host: "127.0.0.1", port: 0 });
  appServer = started.server;
  appBaseUrl = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  delete process.env.MOCK_VIDEO_SOURCE;
  delete process.env.YTDLP_BIN;
  await Promise.all([
    new Promise((resolve) => appServer.close(resolve)),
    new Promise((resolve) => cloudServer.close(resolve)),
  ]);
  await fs.rm(root, { recursive: true, force: true });
});

test("YouTube API imports a public video into a project", async () => {
  const createResponse = await fetch(`${appBaseUrl}/api/projects/youtube`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://youtu.be/BaW_jenozKc" }),
  });
  assert.equal(createResponse.status, 202);
  const sourceImport = await createResponse.json();

  let status;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(
      `${appBaseUrl}/api/projects/youtube/${sourceImport.id}/status`,
    );
    status = await response.json();
    if (status.status === "ready" || status.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(status.status, "ready", status.message);
  assert.equal(status.project.originalName, "Imported video.mkv");
  assert.equal(status.project.media.audioTracks.length, 1);
});

test("automatic API creates a dubbed MKV without an uploaded dub track", async () => {
  const settingsResponse = await fetch(`${appBaseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "test-key", baseUrl: cloudBaseUrl }),
  });
  assert.equal(settingsResponse.status, 200);

  const projectBody = new FormData();
  projectBody.append(
    "video",
    new Blob([await fs.readFile(sourcePath)], { type: "video/x-matroska" }),
    "source.mkv",
  );
  const projectResponse = await fetch(`${appBaseUrl}/api/projects`, {
    method: "POST",
    body: projectBody,
  });
  assert.equal(projectResponse.status, 200);
  const project = await projectResponse.json();

  const generateResponse = await fetch(
    `${appBaseUrl}/api/projects/${project.id}/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mixMode: "quick", voice: "coral" }),
    },
  );
  assert.equal(generateResponse.status, 202);

  let status;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(
      `${appBaseUrl}/api/projects/${project.id}/status`,
    );
    status = await response.json();
    if (status.status === "ready" || status.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(status.status, "ready", status.message);
  const download = await fetch(`${appBaseUrl}${status.downloadUrl}`);
  assert.equal(download.status, 200);
  const outputPath = path.join(root, "downloaded.mkv");
  await fs.writeFile(outputPath, Buffer.from(await download.arrayBuffer()));

  const media = await probeMedia(outputPath);
  assert.equal(media.audioTracks.length, 2);
  assert.equal(media.subtitleTracks.length, 1);
});
