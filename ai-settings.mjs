import fs from "node:fs/promises";
import path from "node:path";

export const AI_PROVIDER_PRESETS = {
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    transcriptionModel: "FunAudioLLM/SenseVoiceSmall",
    translationModel: "Qwen/Qwen3.5-35B-A3B",
    speechModel: "FunAudioLLM/CosyVoice2-0.5B",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    transcriptionModel: "whisper-1",
    translationModel: "gpt-4.1-mini",
    speechModel: "gpt-4o-mini-tts",
  },
};

export const DEFAULT_AI_SETTINGS = {
  provider: "siliconflow",
  ...AI_PROVIDER_PRESETS.siliconflow,
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
    provider:
      process.env.AI_PROVIDER ||
      saved.provider ||
      (saved.baseUrl
        ? saved.baseUrl.includes("siliconflow")
          ? "siliconflow"
          : "openai"
        : DEFAULT_AI_SETTINGS.provider),
    apiKey: process.env.OPENAI_API_KEY || saved.apiKey || "",
    baseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL || saved.baseUrl),
  };
}

export async function saveAiSettings(root, input) {
  const current = await loadAiSettings(root);
  const provider = ["siliconflow", "openai", "custom"].includes(input.provider)
    ? input.provider
    : current.provider;
  const preset = AI_PROVIDER_PRESETS[provider] || current;
  const submittedKey = String(input.apiKey || "").trim();
  const next = {
    provider,
    baseUrl: normalizeBaseUrl(input.baseUrl || preset.baseUrl),
    apiKey: submittedKey || (provider === current.provider ? current.apiKey : ""),
    transcriptionModel: String(
      input.transcriptionModel || preset.transcriptionModel,
    ).trim(),
    translationModel: String(
      input.translationModel || preset.translationModel,
    ).trim(),
    speechModel: String(input.speechModel || preset.speechModel).trim(),
  };

  if (!next.apiKey) {
    throw new Error("切换 AI 服务时，请输入对应的 API Key。");
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
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    transcriptionModel: settings.transcriptionModel,
    translationModel: settings.translationModel,
    speechModel: settings.speechModel,
  };
}
