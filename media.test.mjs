import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { before, test } from "node:test";
import {
  buildMixedMuxArgs,
  buildMuxArgs,
  muxDubbedTrack,
  muxMixedDubbedTrack,
  probeMedia,
  run,
} from "./media.mjs";
import {
  extractPrimaryAudio,
  getSeparatedBackgroundPath,
  separateBackground,
} from "./separation.mjs";

const storageDir = new URL("./storage/", import.meta.url).pathname;
const fixture = path.join(storageDir, "test-fixture.mkv");
const dubFixture = path.join(storageDir, "test-dub.wav");
const outputFixture = path.join(storageDir, "test-output.mkv");
const mixedOutputFixture = path.join(storageDir, "test-mixed-output.mkv");
const subtitleOutputFixture = path.join(storageDir, "test-subtitle-output.mkv");
const subtitleFixture = path.join(storageDir, "test-zh.srt");
const demucsAudioFixture = path.join(storageDir, "test-demucs-input.wav");
const demucsWorkDir = path.join(storageDir, "test-demucs-work");

before(async () => {
  await fs.mkdir(storageDir, { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x286a55:s=320x180:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    fixture,
  ]);
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:duration=1",
    dubFixture,
  ]);
  await extractPrimaryAudio(fixture, demucsAudioFixture);
  await fs.writeFile(
    subtitleFixture,
    "1\n00:00:00,000 --> 00:00:00,900\n测试字幕\n",
  );
});

test("buildMuxArgs appends Chinese audio after original tracks", () => {
  const args = buildMuxArgs({
    videoPath: "/tmp/source.mkv",
    audioPath: "/tmp/dub.wav",
    outputPath: "/tmp/output.mkv",
    originalAudioTracks: 2,
    duration: 12.5,
  });

  assert.deepEqual(args.slice(0, 6), [
    "-y",
    "-i",
    "/tmp/source.mkv",
    "-i",
    "/tmp/dub.wav",
    "-map",
  ]);
  assert.equal(args[args.indexOf("-c") + 1], "copy");
  assert.ok(args.includes("-c:a:2"));
  assert.ok(args.includes("-metadata:s:a:2"));
  assert.ok(args.includes("title=中文配音"));
  assert.ok(args.includes("-disposition:a:2"));
  assert.equal(args[args.indexOf("-t") + 1], "12.5");
});

test("buildMixedMuxArgs mixes a background and dubbed track", () => {
  const args = buildMixedMuxArgs({
    videoPath: "/tmp/source.mkv",
    audioPath: "/tmp/dub.wav",
    backgroundPath: "/tmp/no_vocals.wav",
    outputPath: "/tmp/output.mkv",
    originalAudioTracks: 1,
    duration: 12.5,
  });

  assert.ok(args.includes("/tmp/no_vocals.wav"));
  assert.ok(args.includes("[mixed]"));
  assert.match(args[args.indexOf("-filter_complex") + 1], /amix/);
  assert.match(args[args.indexOf("-filter_complex") + 1], /alimiter/);
});

test("probeMedia reports generated video and audio tracks", async () => {
  const media = await probeMedia(fixture);

  assert.equal(media.video.codec, "h264");
  assert.equal(media.audioTracks.length, 1);
  assert.ok(media.duration > 0.8);
});

test("muxDubbedTrack creates a two-audio-track MKV", async () => {
  await muxDubbedTrack({
    videoPath: fixture,
    audioPath: dubFixture,
    outputPath: outputFixture,
    originalAudioTracks: 1,
    duration: 1,
  });

  const media = await probeMedia(outputFixture);
  assert.equal(media.audioTracks.length, 2);
  assert.equal(media.audioTracks[1].codec, "aac");
  assert.ok(media.duration >= 0.9 && media.duration <= 1.1);
});

test("muxMixedDubbedTrack creates a mixed Chinese track", async () => {
  await muxMixedDubbedTrack({
    videoPath: fixture,
    audioPath: dubFixture,
    outputPath: mixedOutputFixture,
    originalAudioTracks: 1,
    duration: 1,
  });

  const media = await probeMedia(mixedOutputFixture);
  assert.equal(media.audioTracks.length, 2);
  assert.equal(media.audioTracks[1].codec, "aac");
});

test("muxDubbedTrack preserves original media and appends Chinese subtitles", async () => {
  await muxDubbedTrack({
    videoPath: fixture,
    audioPath: dubFixture,
    subtitlePath: subtitleFixture,
    outputPath: subtitleOutputFixture,
    originalAudioTracks: 1,
    originalSubtitleTracks: 0,
    duration: 1,
  });

  const media = await probeMedia(subtitleOutputFixture);
  assert.equal(media.audioTracks.length, 2);
  assert.equal(media.subtitleTracks.length, 1);
});

test(
  "Demucs produces a no-vocals background track",
  { skip: process.env.RUN_DEMUCS_TEST !== "1" },
  async () => {
    await fs.rm(demucsWorkDir, { recursive: true, force: true });
    const output = await separateBackground(
      demucsAudioFixture,
      demucsWorkDir,
    );
    assert.equal(output, getSeparatedBackgroundPath(demucsWorkDir));
    const media = await probeMedia(output);
    assert.equal(media.audioTracks.length, 1);
  },
);
