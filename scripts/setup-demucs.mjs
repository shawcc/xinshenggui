import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export async function setupDemucs({
  root = process.env.DEMUCS_ROOT || process.cwd(),
  uvBin = process.env.UV_PATH || "uv",
  onProgress = () => {},
} = {}) {
  const runtimeRoot = path.join(root, ".python-demucs");
  const environment = path.join(root, ".venv-demucs");
  const python = path.join(environment, "bin", "python");
  const manifestPath = path.join(root, ".demucs-runtime.json");

  await fs.mkdir(root, { recursive: true });
  await Promise.all([
    fs.rm(runtimeRoot, { recursive: true, force: true }),
    fs.rm(environment, { recursive: true, force: true }),
    fs.rm(manifestPath, { force: true }),
  ]);

  onProgress(8, "正在准备 Python");
  await run(uvBin, [
    "python",
    "install",
    "3.11",
    "--install-dir",
    runtimeRoot,
  ], root);

  const runtimeDirectory = (await fs.readdir(runtimeRoot, {
    withFileTypes: true,
  })).find(
    (entry) => entry.isDirectory() && entry.name.startsWith("cpython-3.11"),
  );

  if (!runtimeDirectory) {
    throw new Error("未找到 Demucs 的独立 Python 运行时。");
  }

  const runtimePython = path.join(
    runtimeRoot,
    runtimeDirectory.name,
    "bin",
    "python3.11",
  );

  onProgress(24, "正在创建本地运行环境");
  await run(uvBin, [
    "venv",
    "--relocatable",
    "--python",
    runtimePython,
    environment,
  ], root);

  onProgress(38, "正在下载音频计算组件");
  const torchArgs = [
    "pip",
    "install",
    "--python",
    python,
    "torch==2.2.2",
    "torchaudio==2.2.2",
  ];
  const customIndex = process.env.DEMUCS_TORCH_INDEX;

  if (customIndex && customIndex !== "default") {
    torchArgs.push("--index-url", customIndex);
  } else if (!customIndex && process.platform === "linux") {
    torchArgs.push("--index-url", "https://download.pytorch.org/whl/cpu");
  }

  await run(uvBin, torchArgs, root);

  onProgress(72, "正在安装清晰分离组件");
  await run(uvBin, [
    "pip",
    "install",
    "--python",
    python,
    "demucs==4.0.1",
    "numpy<2",
  ], root);

  const manifest = {
    python: path.relative(root, runtimePython),
    sitePackages: path.relative(
      root,
      path.join(environment, "lib", "python3.11", "site-packages"),
    ),
  };
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  onProgress(100, "清晰分离组件已就绪");
  return manifest;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-12000);
        process.stdout.write(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code}\n${output}`));
    });
  });
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === scriptPath;

if (isDirectRun) {
  await setupDemucs();
  console.log("Demucs 可迁移运行环境已就绪。");
}
