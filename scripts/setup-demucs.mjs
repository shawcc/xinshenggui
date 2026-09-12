import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const environment = path.join(root, ".venv-demucs");
const python = path.join(environment, "bin", "python");

run("uv", ["venv", "--python", "3.11", environment]);

const torchArgs = ["pip", "install", "--python", python, "torch"];
const customIndex = process.env.DEMUCS_TORCH_INDEX;

if (customIndex && customIndex !== "default") {
  torchArgs.push("--index-url", customIndex);
} else if (!customIndex && process.platform === "linux") {
  torchArgs.push("--index-url", "https://download.pytorch.org/whl/cpu");
}

run("uv", torchArgs);
run("uv", ["pip", "install", "--python", python, "demucs", "numpy"]);

console.log("Demucs 本地环境已就绪。");

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
