import { homedir } from 'node:os';
import { join } from 'node:path';

const rootDir = process.env.FEISHU_DEVOPS_HOME ?? join(homedir(), '.feishu-devops');

export const paths = {
  rootDir,
  configFile: join(rootDir, 'config.json'),
  workspacesFile: join(rootDir, 'workspaces.json'),
  sessionsFile: join(rootDir, 'sessions.json'),
};
