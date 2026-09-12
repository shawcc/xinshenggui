import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_AI_SETTINGS = {
  baseUrl: "https://api.openai.com/v1",
  transcriptionModel: "whisper-1",
  translationModel: "gpt-4.1-mini",
  speechModel: "gpt-4o-mini-tts",
};

function settingsPath(root) {
  return path.join(root, "ai-settings.json");
}

function normalizeBaseUrl(value) {
  const candidate = String(value || DEFAULT_AI_SETTINGS.baseUrl)
    .trim()
    .replace(/\/+$/, "");
  const parsed = new URL(candidate);
  const isLocal =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";

  if (parsed.protocol !== "https:" && !(isLocal && parsed.protocol === "http:")) {
    throw new Error("AI 服务地址必须使用 HTTPS。");
  }
  return candidate;
}

export async function loadAiSettings(root) {
  let saved = {};
  try {
    saved = JSON.parse(await fs.readFile(settingsPath(root), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return {
    ...DEFAULT_AI_SETTINGS,
    ...saved,
    apiKey: process.env.OPENAI_API_KEY || saved.apiKey || "",
    baseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL || saved.baseUrl),
  };
}

export async function saveAiSettings(root, input) {
  const current = await loadAiSettings(root);
  const next = {
    baseUrl: normalizeBaseUrl(input.baseUrl || current.baseUrl),
    apiKey: String(input.apiKey || current.apiKey).trim(),
    transcriptionModel: String(
      input.transcriptionModel || current.transcriptionModel,
    ).trim(),
    translationModel: String(
      input.translationModel || current.translationModel,
    ).trim(),
    speechModel: String(input.speechModel || current.speechModel).trim(),
  };

  if (!next.apiKey) {
    throw new Error("请输入 AI 服务 API Key。");
  }

  await fs.mkdir(root, { recursive: true });
  const target = settingsPath(root);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, target);
  return next;
}

export function toPublicAiSettings(settings) {
  return {
    configured: Boolean(settings.apiKey),
    baseUrl: settings.baseUrl,
    transcriptionModel: settings.transcriptionModel,
    translationModel: settings.translationModel,
    speechModel: settings.speechModel,
  };
}
