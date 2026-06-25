# feishu-message-test

飞书消息收发测试项目。参考 [lark-coding-agent-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge)，但**不对接 LLM**，仅做固定内容回复。

## 功能

- 首次运行通过扫码创建 PersonalAgent 飞书应用（`@larksuite/channel` 的 `registerApp`）
- 用户授权后通过 WebSocket 接收消息
- 固定回复规则：
  - 收到 `ping` → 回复 `pong`
  - 其他消息 → 回复 `hello world`（可在配置中修改 `preferences.defaultReply`）
- 斜杠命令：
  - `/cmd <shell>` — 在本机执行 shell 命令并返回输出（如 `/cmd pwd`）；长命令会先在同一条消息显示「正在执行…」并刷新耗时，完成后原地替换为结果
  - `/help` — 显示命令帮助

## 环境要求

- Node.js >= 20.12

## 快速开始

```bash
# 安装依赖
npm install

# 开发运行（直接执行 TypeScript 源码，无需 build）
npm run dev
# 或单次运行
npm start
```

`npm run dev` 会监听 `src/` 变更并自动重启；改代码后保存即可，不用手动 build。

生产/发布前再打包：

```bash
npm run build
npm run start:dist
```

扫码完成后，配置会保存到 `~/.feishu-message-test/config.json`。

在飞书中找到刚创建的应用，发私聊消息或在群里 @ 机器人：

- 发 `ping` → 收到 `pong`
- 发任意其他内容 → 收到 `hello world`

## 使用已有应用

```bash
node bin/feishu-message-test.mjs run \
  --app-id cli_xxxxxxxxxxxx \
  --app-secret <your-secret> \
  --tenant feishu
```

国际版 Lark：

```bash
node bin/feishu-message-test.mjs run --app-id cli_xxx --app-secret <secret> --tenant lark
```

## 配置

配置文件默认路径：`~/.feishu-message-test/config.json`

可通过环境变量 `FEISHU_MESSAGE_TEST_HOME` 修改数据目录。

```json
{
  "accounts": {
    "app": {
      "id": "cli_xxxxxxxxxxxx",
      "secret": "xxxxxxxx",
      "tenant": "feishu"
    }
  },
  "preferences": {
    "requireMentionInGroup": true,
    "defaultReply": "hello world"
  }
}
```

- `requireMentionInGroup`：群中是否必须 @ 机器人才响应（默认 `true`）；私聊始终响应
- `defaultReply`：非 `ping` 消息时的固定回复内容
- `cmdEnabled`：是否允许 `/cmd`（默认 `true`）
- `cmdTimeoutSeconds`：`/cmd` 超时秒数（默认 `30`，最大 `120`）
- `cmdProgressIntervalSeconds`：`/cmd` 执行中状态刷新间隔（默认 `5` 秒；设为 `0` 则只显示初始「正在执行」不周期性刷新，最大 `60`）

> **安全提示**：`/cmd` 会在运行 bot 的本机执行任意 shell 命令，仅建议在可信环境使用。

## 项目结构

```
src/
├── bot/
│   ├── wizard.ts      # 扫码创建应用（来自 lark-coding-agent-bridge）
│   ├── channel.ts     # WebSocket 连接与消息处理
│   └── reply.ts       # 固定回复逻辑
├── cli/
│   ├── index.ts       # CLI 入口
│   ├── start.ts       # 启动流程
│   └── bootstrap.ts   # 配置引导
├── config/            # 配置读写
├── platform/          # 原子写入
└── utils/
    └── feishu-auth.ts # 凭证校验
```

## 与参考项目的差异

| 参考项目 (lark-coding-agent-bridge) | 本项目 |
|-------------------------------------|--------|
| Claude/Codex agent 适配 | 无 LLM，固定文本回复 |
| 多 profile、加密 keystore | 单配置文件，明文 secret（0600 权限） |
| 流式卡片、slash 命令 | 简单 text 回复 |
| lark-cli 预检、后台 daemon | 仅前台 `run` 命令 |
