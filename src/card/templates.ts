interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function cwdCard(current: string | undefined, effective: string): object {
  const elements: object[] = [
    divMd(`会话 cwd：\`${escapeCode(current ?? '(未设置)')}\``),
    divMd(`实际使用：\`${escapeCode(effective)}\``),
    HR,
    divMd('💡 发送 `/cwd <path>` 设置工作目录，或 `/cwd view` 查看详情'),
  ];
  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  cwd?: string;
  effectiveCwd: string;
  sessionId?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  activeRun: boolean;
  queue?: { active: number; waiting: number; cap: number };
  scope: string;
  chatMode: 'p2p' | 'group';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : '(无)';
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const effectiveLine = `\`${escapeCode(info.effectiveCwd)}\``;
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: \`${escapeCode(info.scope)}\``,
    `📁 **cwd**: ${cwdLine}`,
    `📁 **effective**: ${effectiveLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    `🚦 **queue**: ${queueLine}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'cwd.view' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  preview: string;
  relTime: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有可恢复的会话。发送一条消息即可开始新会话。'));
    return shell('🔁 恢复会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${e.sessionId.slice(0, 8)}…\` · ${escapeMd(e.relTime)}`,
      ),
    );
    if (!e.current) {
      elements.push(
        actions([
          {
            text: '▸ 恢复此会话',
            value: { cmd: 'resume.use', arg: e.sessionId },
            style: 'primary',
          },
        ]),
      );
    }
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复会话', elements);
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- `/new` `/reset` — 清空当前 chat 的 agent 会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- `/resume` — 查看当前可恢复的会话',
        '- `/cwd <path>` — 设置工作目录',
        '- `/cwd view` — 查看工作目录',
        '- `/status` — 当前状态',
        '- `/stop` — 结束当前正在跑的任务',
        '- `/use claude|codex|cursor|pi` — 切换 agent（无需重启）',
        '- `/cmd <shell>` / `$ <shell>` — 本机执行 shell',
        '- `/send <path>` — 发送本地文件',
        '- `/help` — 本帮助',
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
        '',
        '以 `/` 开头的消息都是命令；未知命令不会交给 AI。',
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'cwd.view' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
