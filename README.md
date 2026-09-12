# 新声轨

一个本地桌面工具：为现有视频添加、混音并封装新的配音音轨，输出可在支持多音轨的播放器中切换的 MKV 文件。

## 给使用者

安装“新声轨”后，双击桌面图标即可使用：

1. 选择视频。
2. 选择配音文件。
3. 选择清晰分离或快速混音。
4. 点击生成。

成品会自动保存到系统“视频/新声轨”目录。视频、配音和处理过程均在本机完成；应用不会对外开放局域网或公网端口。

“清晰分离”使用本地 Demucs 去除原片对白并保留音乐、环境声。轻量桌面安装包不再携带完整 AI 运行时；第一次选择清晰分离时，应用会自动下载约 200MB 组件并保存在本机，之后可以离线复用。“快速混音”无需等待组件下载。

## 开发与打包

首次准备本地开发环境：

```bash
npm install
npm run setup:demucs
```

以桌面应用启动：

```bash
npm run desktop:dev
```

生成当前系统可运行的未安装版目录：

```bash
npm run desktop:package
```

在 Mac 上生成安装包：

```bash
npm run desktop:mac
```

生成的 `.dmg` 位于 `dist/`。桌面应用会携带 FFmpeg、FFprobe 和对应芯片架构的 `uv` 引导程序；Demucs 运行时在首次使用时安装到应用数据目录。

首次打开未签名的本地构建应用时，如 macOS 阻止启动，请在 Finder 中按住 Control 点击“新声轨”，选择“打开”并确认一次。

## 自动构建与发布

GitHub Actions 工作流位于 `.github/workflows/macos-release.yml`：

- 手动运行工作流会输出 Apple Silicon 和 Intel 的 `.dmg` 构建产物。
- 推送形如 `v0.1.0` 的 Git 标签会创建 GitHub Release，并附上两个可直接下载的安装文件。
- 工作流会验证 Demucs 运行时安装、首次模型下载和迁移能力，然后在打包前移除完整运行时，只保留轻量安装引导程序。

要让用户直接双击安装且不触发 Gatekeeper 拦截，在仓库 Secrets 中配置：

- `MACOS_CERTIFICATE_P12`：Developer ID Application 证书的 Base64 内容。
- `MACOS_CERTIFICATE_PASSWORD`：证书密码。
- `APPLE_API_KEY`：App Store Connect API 私钥 `.p8` 的内容。
- `APPLE_API_KEY_ID`：API Key ID。
- `APPLE_API_ISSUER`：Issuer ID。

## 浏览器开发模式

仅供开发调试：

```bash
npm start
```

打开 `http://127.0.0.1:4173`。默认仅允许本机访问；不应直接暴露到公网。

## 当前能力

- 导入并探测 MKV、MP4、MOV 等视频。
- 使用本地 Demucs 分离对白，保留音乐和环境声。
- 可跳过分离，直接压低原声进行快速混音。
- 保留原视频、原音轨和字幕。
- 将配音和背景声混合后追加为默认音轨。
- 输出不重新编码画面的多音轨 MKV。
