const state = {
  videoFile: null,
  audioFile: null,
  project: null,
  demucsReady: false,
  installingDemucs: false,
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
    : "选择配音文件";
  updatePackageButton();
});

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
  if (!state.project || !state.audioFile) return;

  const formData = new FormData(packageForm);
  const isSeparating = formData.get("mixMode") === "separate";

  try {
    if (isSeparating && !state.demucsReady) {
      setLoading(packageButton, true, "正在准备清晰分离组件");
      await installDemucs();
    }

    setLoading(
      packageButton,
      true,
      isSeparating ? "正在分离背景声，可能需要几分钟" : "正在混音",
    );
    const body = new FormData();
    body.append("audio", state.audioFile);
    body.append("mixMode", formData.get("mixMode"));
    const response = await fetch(
      `/api/projects/${state.project.id}/package`,
      { method: "POST", body },
    );
    const result = await readResponse(response);
    showSuccess(result);
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(packageButton, false, "混音并生成 MKV");
    updatePackageButton();
  }
});

async function loadCapabilities() {
  try {
    const response = await fetch("/api/health");
    const capabilities = await readResponse(response);
    const badge = $("#access-badge");

    state.demucsReady = capabilities.demucs;
    renderRuntimeState(capabilities.demucsInstall);

    if (capabilities.access === "lan") {
      badge.textContent = "局域网共享";
      badge.title = "同一局域网内的设备可访问，处理仍在这台电脑完成";
    }
  } catch {
    $("#runtime-note").querySelector("strong").textContent =
      "未能确认本地处理环境";
  }
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
      // The install request remains authoritative while status polling retries.
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
      "处理全程在这台电脑完成；首次分离时只需下载 AI 模型。";
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

function setVideo(file) {
  state.videoFile = file;
  videoInput.value = "";
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
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showSuccess(result) {
  packageForm.hidden = true;
  successPanel.hidden = false;
  $("#output-name").textContent = result.outputName;
  $("#processing-result").textContent =
    result.processing === "demucs"
      ? "背景声已通过 Demucs 本地分离"
      : result.processing === "quick"
        ? "已使用快速混音"
        : "视频没有原音轨，已使用纯中文配音";
  $("#download-button").href = result.downloadUrl;
  setStep(3);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function reset() {
  state.videoFile = null;
  state.audioFile = null;
  state.project = null;
  videoInput.value = "";
  audioInput.value = "";
  $("#video-file-row").hidden = true;
  $("#audio-label").textContent = "选择配音文件";
  analyzeButton.disabled = true;
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

function updatePackageButton() {
  packageButton.disabled =
    !state.project || !state.audioFile || state.installingDemucs;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

async function readResponse(response) {
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "操作失败，请稍后重试。");
  }
  return result;
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
