const state = {
  videoFile: null,
  audioFile: null,
  project: null,
  aiConfigured: false,
  demucsReady: false,
  installingDemucs: false,
  processing: false,
};

const $ = (selector) => document.querySelector(selector);
const videoForm = $("#video-form");
const packageForm = $("#package-form");
const successPanel = $("#success-panel");
const videoInput = $("#video-input");
const audioInput = $("#audio-input");
const dropzone = $("#video-dropzone");
const analyzeButton = $("#analyze-button");
const packageButton = $("#package-button");
const toast = $("#toast");

loadCapabilities();

videoInput.addEventListener("change", () => {
  setVideo(videoInput.files[0] ?? null);
});

audioInput.addEventListener("change", () => {
  state.audioFile = audioInput.files[0] ?? null;
  $("#audio-label").textContent = state.audioFile
    ? state.audioFile.name
    : "选择已有配音文件";
  $("#clear-audio").hidden = !state.audioFile;
  updatePackageButton();
});

$("#clear-audio").addEventListener("click", () => {
  state.audioFile = null;
  audioInput.value = "";
  $("#audio-label").textContent = "选择已有配音文件";
  $("#clear-audio").hidden = true;
  updatePackageButton();
});

$("#edit-ai-settings").addEventListener("click", () => {
  $("#ai-config").hidden = false;
  $("#edit-ai-settings").hidden = true;
  $("#ai-api-key").focus();
});

$("#save-ai-settings").addEventListener("click", saveAiSettings);

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  });
}

dropzone.addEventListener("drop", (event) => {
  const file = [...event.dataTransfer.files].find(
    (candidate) =>
      candidate.type.startsWith("video/") ||
      candidate.name.toLowerCase().endsWith(".mkv"),
  );
  if (!file) {
    showToast("请拖入一个视频文件。");
    return;
  }
  setVideo(file);
});

$("#clear-video").addEventListener("click", () => {
  setVideo(null);
});

$("#change-video").addEventListener("click", reset);
$("#restart-button").addEventListener("click", reset);

videoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.videoFile) return;

  setLoading(analyzeButton, true, "正在读取视频");
  const body = new FormData();
  body.append("video", state.videoFile);

  try {
    const response = await fetch("/api/projects", { method: "POST", body });
    const result = await readResponse(response);
    state.project = result;
    showSettings(result);
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(analyzeButton, false, "读取视频");
  }
});

packageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.project || state.processing) return;

  const formData = new FormData(packageForm);
  const isSeparating = formData.get("mixMode") === "separate";

  try {
    state.processing = true;
    updatePackageButton();
    if (isSeparating && !state.demucsReady) {
      setLoading(packageButton, true, "正在准备清晰分离组件");
      await installDemucs();
    }

    if (state.audioFile) {
      await packageExistingAudio(formData);
    } else {
      if (!state.aiConfigured) {
        $("#ai-config").hidden = false;
        $("#edit-ai-settings").hidden = true;
        $("#ai-api-key").focus();
        throw new Error("请先填写 API Key 并连接云端 AI。");
      }
      await generateAutomaticDub(formData);
    }
  } catch (error) {
    hideGenerationProgress();
    showToast(error.message);
  } finally {
    state.processing = false;
    setLoading(packageButton, false, packageButtonLabel());
    updatePackageButton();
  }
});

async function packageExistingAudio(formData) {
  setLoading(packageButton, true, "正在混音并封装");
  const body = new FormData();
  body.append("audio", state.audioFile);
  body.append("mixMode", formData.get("mixMode"));
  const response = await fetch(
    `/api/projects/${state.project.id}/package`,
    { method: "POST", body },
  );
  showSuccess(await readResponse(response));
}

async function generateAutomaticDub(formData) {
  renderGenerationProgress({
    progress: 1,
    message: "正在准备自动配音",
  });
  setLoading(packageButton, true, "正在自动生成中文配音");

  const response = await fetch(
    `/api/projects/${state.project.id}/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mixMode: formData.get("mixMode"),
        voice: formData.get("voice"),
      }),
    },
  );
  await readResponse(response);

  while (true) {
    await delay(900);
    const statusResponse = await fetch(
      `/api/projects/${state.project.id}/status`,
    );
    const status = await readResponse(statusResponse);
    renderGenerationProgress(status);

    if (status.status === "ready") {
      showSuccess(status);
      return;
    }
    if (status.status === "failed") {
      throw new Error(status.message || "自动配音失败，请稍后重试。");
    }
  }
}

async function loadCapabilities() {
  try {
    const response = await fetch("/api/health");
    const capabilities = await readResponse(response);
    const badge = $("#access-badge");

    state.demucsReady = capabilities.demucs;
    state.aiConfigured = capabilities.ai.configured;
    renderRuntimeState(capabilities.demucsInstall);
    renderAiSettings(capabilities.ai);

    if (capabilities.access === "lan") {
      badge.textContent = "局域网共享";
      badge.title = "同一局域网内的设备可访问，处理仍在这台电脑完成";
    }
  } catch {
    $("#runtime-note").querySelector("strong").textContent =
      "未能确认本地处理环境";
  }
}

async function saveAiSettings() {
  const button = $("#save-ai-settings");
  const apiKey = $("#ai-api-key").value.trim();
  const baseUrl = $("#ai-base-url").value.trim();

  if (!apiKey && !state.aiConfigured) {
    showToast("请输入 AI 服务 API Key。");
    return;
  }

  button.disabled = true;
  button.textContent = "正在保存";
  try {
    const response = await fetch("/api/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, baseUrl }),
    });
    const settings = await readResponse(response);
    state.aiConfigured = settings.configured;
    $("#ai-api-key").value = "";
    renderAiSettings(settings);
    showToast("AI 服务设置已保存。");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "保存并连接";
    updatePackageButton();
  }
}

function renderAiSettings(settings = {}) {
  const configured = Boolean(settings.configured);
  $("#ai-base-url").value =
    settings.baseUrl || "https://api.openai.com/v1";
  $("#ai-service").classList.toggle("is-connected", configured);
  $("#ai-service-title").textContent = configured
    ? "云端 AI 已配置"
    : "连接云端 AI";
  $("#ai-service-detail").textContent = configured
    ? new URL(settings.baseUrl).host
    : "用于识别、翻译和生成中文语音";
  $("#ai-config").hidden = configured;
  $("#edit-ai-settings").hidden = !configured;
  updatePackageButton();
}

async function installDemucs() {
  state.installingDemucs = true;
  updatePackageButton();
  renderRuntimeState({
    status: "installing",
    progress: 1,
    message: "正在连接组件服务器",
  });

  const poller = setInterval(async () => {
    try {
      const response = await fetch("/api/health");
      const capabilities = await readResponse(response);
      if (!state.installingDemucs) return;

      state.demucsReady = capabilities.demucs;
      renderRuntimeState(capabilities.demucsInstall);
    } catch {
      // The install request remains authoritative while polling retries.
    }
  }, 800);

  try {
    const response = await fetch("/api/runtime/demucs/install", {
      method: "POST",
    });
    const result = await readResponse(response);
    state.demucsReady = result.demucs;
    renderRuntimeState(result);
  } finally {
    clearInterval(poller);
    state.installingDemucs = false;
    updatePackageButton();
  }
}

function renderRuntimeState(runtime = {}) {
  const note = $("#runtime-note");
  const progress = $("#runtime-progress");
  const progressBar = $("#runtime-progress-bar");
  const progressLabel = $("#runtime-progress-label");

  if (state.demucsReady || runtime.status === "ready") {
    note.querySelector("strong").textContent = "清晰分离组件已就绪";
    $("#runtime-detail").textContent =
      "背景声音处理全程在本机完成。";
    progress.hidden = true;
    return;
  }

  if (runtime.status === "installing") {
    const value = Number(runtime.progress || 0);
    note.querySelector("strong").textContent =
      runtime.message || "正在准备清晰分离组件";
    $("#runtime-detail").textContent =
      "请保持应用打开，下载完成后会自动继续处理。";
    progressBar.value = value;
    progressLabel.textContent = `${value}%`;
    progress.hidden = false;
    return;
  }

  note.querySelector("strong").textContent =
    runtime.status === "failed" ? "组件下载未完成" : "按需下载";
  $("#runtime-detail").textContent =
    "首次使用清晰分离时自动下载约 200 MB 组件，之后可以离线使用。";
  progress.hidden = true;
}

function renderGenerationProgress(status = {}) {
  const value = Math.max(0, Math.min(100, Number(status.progress || 0)));
  $("#generation-progress").hidden = false;
  $("#generation-message").textContent =
    status.message || "正在自动生成中文配音";
  $("#generation-percent").textContent = `${value}%`;
  $("#generation-progress-bar").value = value;
}

function hideGenerationProgress() {
  $("#generation-progress").hidden = true;
}

function setVideo(file) {
  state.videoFile = file;
  if (!file) videoInput.value = "";
  analyzeButton.disabled = !file;
  $("#video-file-row").hidden = !file;

  if (file) {
    $("#video-file-name").textContent = file.name;
    $("#video-file-size").textContent = formatBytes(file.size);
  }
}

function showSettings(project) {
  videoForm.hidden = true;
  packageForm.hidden = false;
  successPanel.hidden = true;

  $("#summary-name").textContent = project.originalName;
  const details = [];
  if (project.media.video) {
    details.push(
      `${project.media.video.width}×${project.media.video.height}`,
      project.media.video.codec.toUpperCase(),
    );
  }
  details.push(formatDuration(project.media.duration));
  details.push(`${project.media.audioTracks.length} 条原音轨`);
  $("#summary-meta").textContent = details.join(" · ");
  setStep(2);
  updatePackageButton();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showSuccess(result) {
  hideGenerationProgress();
  packageForm.hidden = true;
  successPanel.hidden = false;
  $("#output-name").textContent = result.outputName;
  $("#processing-result").textContent = processingLabel(result.processing);
  $("#download-button").href = result.downloadUrl;
  setStep(3);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function processingLabel(processing) {
  if (processing === "demucs-ai") return "已自动翻译配音，并分离原片背景声";
  if (processing === "quick-ai") return "已自动翻译配音，并完成快速混音";
  if (processing === "demucs") return "已使用现成配音，并分离原片背景声";
  if (processing === "quick") return "已使用现成配音完成快速混音";
  return "已生成中文配音音轨";
}

function reset() {
  state.videoFile = null;
  state.audioFile = null;
  state.project = null;
  state.processing = false;
  videoInput.value = "";
  audioInput.value = "";
  $("#video-file-row").hidden = true;
  $("#audio-label").textContent = "选择已有配音文件";
  $("#clear-audio").hidden = true;
  analyzeButton.disabled = true;
  hideGenerationProgress();
  updatePackageButton();
  videoForm.hidden = false;
  packageForm.hidden = true;
  successPanel.hidden = true;
  setStep(1);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setStep(activeStep) {
  document.querySelectorAll("[data-step-indicator]").forEach((item) => {
    const step = Number(item.dataset.stepIndicator);
    item.classList.toggle("is-active", step === activeStep);
    item.classList.toggle("is-complete", step < activeStep);
  });
}

function setLoading(button, loading, label) {
  button.classList.toggle("is-loading", loading);
  button.disabled = loading;
  button.querySelector("span").textContent = label;
}

function packageButtonLabel() {
  return state.audioFile
    ? "使用配音文件并生成 MKV"
    : "自动生成中文配音";
}

function updatePackageButton() {
  packageButton.querySelector("span").textContent = packageButtonLabel();
  packageButton.disabled =
    !state.project ||
    state.installingDemucs ||
    state.processing ||
    (!state.audioFile && !state.aiConfigured);
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => {
    toast.hidden = true;
  }, 5200);
}

async function readResponse(response) {
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "操作失败，请稍后重试。");
  }
  return result;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}
