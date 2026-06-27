# Agent prompt 改走 stdin(修复 Windows 下「未返回内容」)

> 关联提交：`66044d3`、`6d204e4`
> 适用范围：claude / pi / cursor 三个 adapter(codex 本来就用 stdin)

## 一、问题现象

- 飞书里给 agent 发消息(如「你好」),回复显示 **「（未返回内容）」**。
- 只在 **Windows 服务**下复现;直接在 PowerShell 终端手敲 `pi --mode json -p "你好"` 正常。
- **claude 和 pi 都中招** → 不是某个 agent 的 bug,是公共的调用路径问题。
- **linux / mac 正常**。
- `/cmd` 执行命令在 Windows 服务下也正常。

## 二、根因

「未返回内容」对应的代码是 `src/card/text-renderer.ts`:

```ts
} else if (state.terminal === 'done' && parts.length === 0) {
  parts.push('_（未返回内容）_');
}
```

即:运行以 `terminal: 'done'` 结束,但**没有任何文本块**。

翻看各 adapter 的 `createEventStream`:`done` 是**合成的**——只要子进程 `exit code === 0` 且没解析出 JSON,就会合成一个空 `done`。而之前四个 adapter 对 stdout 的处理都是:

```ts
try { parsed = JSON.parse(trimmed); }
catch { continue; }   // ← 非 JSON 行被静默丢弃,不留任何痕迹
```

所以当 agent 在 Windows 服务下往 stdout 打了**纯文本**(而非 JSON)、又 exit 0 时,所有行被丢弃 → 合成空 `done` → 「未返回内容」,且日志里干干净净,无法排查。

### 为什么 agent 会退化成纯文本模式?

旧代码把 **bridge 系统提示词 + 用户 prompt 当成命令行参数**传给 agent:

- claude:`-p <prompt> ... --append-system-prompt <BRIDGE_SYSTEM_PROMPT>`
- pi:`--mode json -p ... --append-system-prompt <BRIDGE_SYSTEM_PROMPT> <prompt>`

这两段文本里有大量 cmd.exe 的「地雷」:

- 双引号 `"`(JSON 示例里)
- 反引号 `` ` ``(代码段)
- 尖括号 `<>`(`<bridge_context>` 等标签)
- 中文

**Windows 上 `claude` / `pi` 是 `.cmd` 批处理 shim**,Node spawn 它时会经 `cmd.exe /d /s /c "..."` 转发。而 **cmd.exe 对参数里嵌入的引号转义天生不可靠**——引号边界一破,破口之后的参数全部被并进 prompt 文本里,其中就包括 `--output-format stream-json` / `--mode json`。

agent 实际收到的是「一段超长 prompt + 普通模式」,于是**退化为纯文本输出**,JSON 解析全军覆没。

### 为什么之前的现象都对得上?

| 现象 | 原因 |
|---|---|
| PowerShell 手敲 `pi -p "你好"` 正常 | 短 prompt、无特殊字符,引号不破 |
| linux / mac 正常 | 直接 exec,没有 `.cmd` / cmd.exe 这一层 |
| `/cmd` 正常 | 走 PowerShell,不经过 agent 的 JSON 解析路径 |
| claude、pi 都中招 | 共用「prompt 当 argv 传」的模式 |
| 最近几次提交没修好 | 那几次改的是 `\r` 换行、环境变量——方向错了,病根在 argv |

## 三、解决方案

**prompt 改走 stdin,argv 只保留短 ASCII flag。** cmd.exe 没有需要转义的内容,`--output-format stream-json` / `--mode json` 不会再被吞。

claude / pi / cursor 统一改为:

```ts
// 系统提示词 + 用户输入合并成一个字符串(codex 同款)
const stdinPrompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);

const args = ['-p', '--output-format', 'stream-json', ...];   // 只剩短 flag
const child = spawnProcess(this.binary, args, {
  cwd: opts.cwd,
  env: ...,
  stdio: ['pipe', 'pipe', 'pipe'],   // stdin 可写
});
// ...
child.stdin.end(stdinPrompt, 'utf8');
```

去掉了 `--append-system-prompt`(argv 里的雷),`stdio` 由 `['ignore', ...]` 改成 `['pipe', ...]`,加了 stdin error 处理。

### 顺带加的诊断日志

旧代码「静默吞掉非 JSON 行」是这次长期定位不到的元凶。新增 `src/agent/read-stdout-lines.ts`:

- `readStdoutJsonLines`:统计 `rawLines / parsedOk / parseFailed`;**非 JSON 行不再静默丢弃**,而是 `log.warn('agent','stdout-non-json', { head })`。
- `summarizeAgentEnv`:把子进程继承的环境压缩成布尔/计数(`hasHome / hasUserprofile / hasAppdata / hasPath / hasAnthropicKey / credentialEnvCount …`)。

四个 adapter 的 spawn 日志新增 `args`(prompt 截断到 80 字符)、`binary`、`via: stdin`;stdout 读完后新增 `stdout-summary`(rawLines/parsedOk/parseFailed/exitCode);若 `rawLines === 0` 再来一条 `stdout-empty` warn。

## 四、优缺点

### 优点

- **彻底解决 Windows argv 引号破坏问题**,claude / pi 已实测恢复 JSON 输出。
- **四个 adapter 行为统一**(codex 本来就用 stdin),维护更简单。
- prompt 不再出现在进程命令行里(`ps` / 任务管理器),**减少泄露**,更干净。
- 诊断日志让「未返回内容」这类静默失败**有迹可循**。

### 缺点 / 折中

1. **系统提示词被「降级」成用户消息(最主要)**

   之前 `--append-system-prompt` 把 `BRIDGE_SYSTEM_PROMPT` 放在**真正的 system prompt 位**,现在它和用户输入合并后进了 **user 消息**。影响:
   - **指令权重略降**:模型对 system 位的指令默认权重更高。不过 bridge 指令是操作性的、每轮都重发,实测照办,实际影响很小。
   - **长会话 token 重复**:resume 多轮会话时,那段 ~5KB 的系统提示词会随每轮 user 消息进历史(N 轮堆 N 份)。好在是稳定前缀,**prompt caching 基本能覆盖**,成本增加有限。

2. **cursor 未实测**

   claude、pi 都实测了 stdin 可用;cursor 的 `agent` 本机未安装,「`agent -p` 支持从 stdin 读」是**未验证假设**(接口与 claude 同源,大概率没问题)。用 cursor 的话建议重启后测一下。

3. **改动是全局的,不止 Windows**

   linux/mac 之前用 argv 是好的,现在也一并改成 stdin。为修 Windows 的问题动了本没问题的平台。可接受(stdin 各平台都稳、且统一),但属于「治法比病大」一点。

### 可选的进一步改进

- **pi 保留真正的 system prompt**:pi 的 `--append-system-prompt` 文档写明支持「text **or file contents**」,可把系统提示词写临时文件、传文件路径——既绕开 argv 引号、又保留 system 语义。但会让 pi 跟其它三个又不一致、多一层临时文件管理,**当前不做**。
- **最小化改动**:做成「Windows 走 stdin、其它平台仍走 argv」。会让代码分叉、维护更累,**不推荐**。

## 五、如何排查同类问题

复现后看当天日志(`<rootDir>/logs/bridge-<YYYYMMDD>.jsonl`,`/doctor` 也能读),grep:

| event | 含义 |
|---|---|
| `agent.spawn` | `args` / `binary` / `via` —— 确认传给子进程的真实参数 |
| `agent.spawn-env` | `hasUserprofile / hasHome / hasPath / credentialEnvCount` —— 确认子进程环境 |
| `agent.stdout-summary` | `rawLines / parsedOk / parseFailed / exitCode` —— stdout 汇总 |
| `agent.stdout-empty` | `rawLines === 0`,直接对应「未返回内容」 |
| `agent.stdout-non-json` | 子进程输出了非 JSON 行(以前的盲区) |
| `agent.stderr` / `agent.exit` | agent 自己的报错与退出码 |
