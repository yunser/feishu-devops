import { createInterface } from 'node:readline';
import { runRegistrationWizard } from '../bot/wizard';
import type { AppConfig, TenantBrand } from '../config/schema';
import { isComplete } from '../config/schema';
import { paths } from '../config/paths';
import { loadConfig, saveConfig } from '../config/store';
import { validateAppCredentials } from '../utils/feishu-auth';

export interface BootstrapOptions {
  config?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
}

export interface BootstrapResult {
  cfg: AppConfig;
  configPath: string;
}

export async function resolveConfig(opts: BootstrapOptions): Promise<BootstrapResult> {
  const configPath = opts.config ?? paths.configFile;

  const cfg = await loadConfig(configPath);

  if (!isComplete(cfg)) {
    const fresh = await bootstrapAppConfig(opts);
    await saveConfig(fresh, configPath);
    console.log(`配置已保存到 ${configPath}\n`);
    return { cfg: fresh, configPath };
  }

  if (opts.appId && opts.appId !== cfg.accounts.app.id) {
    throw new Error(
      `已有配置使用 App ID ${cfg.accounts.app.id}，与传入的 --app-id ${opts.appId} 不一致。`,
    );
  }

  return { cfg, configPath };
}

async function bootstrapAppConfig(opts: BootstrapOptions): Promise<AppConfig> {
  if (!opts.appId) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        '当前没有配置，非交互模式无法完成扫码创建应用。' +
          '请先在终端运行 `chat-devops run` 完成首次初始化，' +
          '或传入 --app-id 和 --app-secret。',
      );
    }
    return runRegistrationWizard();
  }

  let appSecret = opts.appSecret;
  if (!appSecret) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        `非交互模式缺少 App Secret: ${opts.appId}。` +
          '请传入 --app-secret <secret>，或在终端中重新运行命令后按提示输入。',
      );
    }
    appSecret = await promptPassword(`输入 ${opts.appId} 的 App Secret: `);
  }
  if (!appSecret) throw new Error('app secret is required');

  const tenant = tenantBrandFromString(opts.tenant);
  const result = await validateAppCredentials(opts.appId, appSecret, tenant);
  if (!result.ok) {
    throw new Error(`应用凭证校验失败: ${result.reason ?? 'unknown'}`);
  }
  if (result.botName) {
    console.log(`✓ 应用凭证校验通过: ${result.botName}`);
  } else {
    console.log('✓ 应用凭证校验通过');
  }

  return {
    accounts: {
      app: {
        id: opts.appId,
        secret: appSecret,
        tenant,
      },
    },
    preferences: {
      requireMentionInGroup: true,
      defaultReply: 'hello world',
    },
  };
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function tenantBrandFromString(value: string | undefined): TenantBrand {
  if (value === undefined) return 'feishu';
  if (value === 'feishu' || value === 'lark') return value;
  throw new Error(`unsupported tenant: ${value}`);
}

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
