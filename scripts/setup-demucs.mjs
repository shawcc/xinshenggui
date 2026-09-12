import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const runtimeRoot = path.join(root, ".python-demucs");
const environment = path.join(root, ".venv-demucs");
const python = path.join(environment, "bin", "python");
const manifestPath = path.join(root, ".demucs-runtime.json");

fs.rmSync(runtimeRoot, { recursive: true, force: true });
fs.rmSync(environment, { recursive: true, force: true });
run("uv", ["python", "install", "3.11", "--install-dir", runtimeRoot]);

const runtimeDirectory = fs
  .readdirSync(runtimeRoot, { withFileTypes: true })
  .find((entry) => entry.isDirectory() && entry.name.startsWith("cpython-3.11"));

if (!runtimeDirectory) {
  throw new Error("未找到 Demucs 的独立 Python 运行时。");
}

const runtimePython = path.join(
  runtimeRoot,
  runtimeDirectory.name,
  "bin",
  "python3.11",
);
run("uv", [
  "venv",
  "--relocatable",
  "--python",
  runtimePython,
  environment,
]);

const torchArgs = ["pip", "install", "--python", python, "torch"];
const customIndex = process.env.DEMUCS_TORCH_INDEX;

if (customIndex && customIndex !== "default") {
  torchArgs.push("--index-url", customIndex);
} else if (!customIndex && process.platform === "linux") {
  torchArgs.push("--index-url", "https://download.pytorch.org/whl/cpu");
}

run("uv", torchArgs);
run("uv", ["pip", "install", "--python", python, "demucs", "numpy"]);

fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      python: path.relative(root, runtimePython),
      sitePackages: path.relative(
        root,
        path.join(environment, "lib", "python3.11", "site-packages"),
      ),
    },
    null,
    2,
  )}\n`,
);

console.log("Demucs 可迁移运行环境已就绪。");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
