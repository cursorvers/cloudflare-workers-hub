import { readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { z } from 'zod';

/**
 * 設定スキーマ定義
 */
const ConfigSchema = z.object({
  repositories: z.array(z.string()),
  checkInterval: z.number().min(1000).default(60000),
  workersHubUrl: z.string().url(),
  tunnelPort: z.number().min(1).max(65535).default(3100),
  agent: z.object({
    id: z.string(),
    name: z.string(),
    capabilities: z.array(z.string()),
  }),
  authentication: z.object({
    apiKey: z.string(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * 設定ファイルを読み込み、バリデーションする
 */
export function loadConfig(configPath: string = './config.json'): Config {
  try {
    const rawConfig = readFileSync(configPath, 'utf-8');
    const parsedConfig = JSON.parse(rawConfig);

    // チルダをホームディレクトリに展開
    if (parsedConfig.repositories) {
      parsedConfig.repositories = parsedConfig.repositories.map((path: string) =>
        path.startsWith('~') ? resolve(homedir(), path.slice(2)) : resolve(path)
      );
    }

    return ConfigSchema.parse(parsedConfig);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`設定ファイルの読み込みに失敗: ${error.message}`);
    }
    throw error;
  }
}

/**
 * 設定の検証のみ実施（dry-run用）
 */
export function validateConfig(configPath: string): boolean {
  try {
    loadConfig(configPath);
    return true;
  } catch {
    return false;
  }
}
