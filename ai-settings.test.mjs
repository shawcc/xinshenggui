import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  loadAiSettings,
  saveAiSettings,
  toPublicAiSettings,
} from "./ai-settings.mjs";

let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xinshenggui-settings-"));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("saves AI settings without exposing the key publicly", async () => {
  const saved = await saveAiSettings(root, {
    apiKey: "secret-key",
    baseUrl: "https://api.example.com/v1/",
  });
  const loaded = await loadAiSettings(root);
  const publicSettings = toPublicAiSettings(loaded);

  assert.equal(saved.baseUrl, "https://api.example.com/v1");
  assert.equal(loaded.apiKey, "secret-key");
  assert.equal(publicSettings.configured, true);
  assert.equal("apiKey" in publicSettings, false);
});

test("rejects insecure remote service URLs", async () => {
  await assert.rejects(
    saveAiSettings(root, {
      apiKey: "secret-key",
      baseUrl: "http://api.example.com/v1",
    }),
    /HTTPS/,
  );
});

test("requires a new key when switching providers", async () => {
  await assert.rejects(
    saveAiSettings(root, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    }),
    /API Key/,
  );
});
