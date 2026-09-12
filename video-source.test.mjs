import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { run } from "./media.mjs";
import {
  downloadYouTubeVideo,
  normalizeYouTubeUrl,
} from "./video-source.mjs";

let root;
let sourcePath;
let mockDownloader;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xinshenggui-youtube-"));
  sourcePath = path.join(root, "fixture.mkv");
  mockDownloader = path.join(root, "mock-uv");

  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=160x90:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    sourcePath,
  ]);
  await fs.writeFile(
    mockDownloader,
    [
      "#!/bin/sh",
      'cp "$MOCK_VIDEO_SOURCE" "$PWD/source.mkv"',
      "printf 'title=Test video\\n'",
      "printf 'progress=54.0%%\\n'",
      "printf 'filepath=%s/source.mkv\\n' \"$PWD\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.MOCK_VIDEO_SOURCE = sourcePath;
});

after(async () => {
  delete process.env.MOCK_VIDEO_SOURCE;
  await fs.rm(root, { recursive: true, force: true });
});

test("accepts single YouTube video links", () => {
  assert.equal(
    normalizeYouTubeUrl("https://youtu.be/BaW_jenozKc"),
    "https://youtu.be/BaW_jenozKc",
  );
  assert.match(
    normalizeYouTubeUrl("https://www.youtube.com/watch?v=BaW_jenozKc"),
    /watch\?v=BaW_jenozKc/,
  );
});

test("rejects unsupported or playlist-only URLs", () => {
  assert.throws(
    () => normalizeYouTubeUrl("https://example.com/video"),
    /YouTube/,
  );
  assert.throws(
    () => normalizeYouTubeUrl("https://www.youtube.com/playlist?list=test"),
    /视频 ID/,
  );
});

test("downloads a video through the on-demand downloader", async () => {
  const outputDir = path.join(root, "download");
  const progress = [];
  const result = await downloadYouTubeVideo({
    url: "https://youtu.be/BaW_jenozKc",
    outputDir,
    uvBin: mockDownloader,
    onProgress(value) {
      progress.push(value);
    },
  });

  assert.equal(result.title, "Test video");
  assert.equal(result.path, path.join(outputDir, "source.mkv"));
  assert.deepEqual(progress, [54, 100]);
});
