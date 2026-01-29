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
  // Cloudflare Tunnel settings
  tunnelEnabled: z.boolean().default(false),
  tunnelHostname: z.string().optional(),
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
 * 環境変数を展開する
 * ${VAR_NAME} または $VAR_NAME 形式をサポート
 */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (_, varName) => {
    return process.env[varName] || '';
  });
}

/**
 * オブジェクト内の全ての文字列値の環境変数を再帰的に展開
 */
function expandEnvVarsRecursive(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return expandEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVarsRecursive);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsRecursive(value);
    }
    return result;
  }
  return obj;
}

/**
 * 設定ファイルを読み込み、バリデーションする
 */
export function loadConfig(configPath: string = './config.json'): Config {
  try {
    const rawConfig = readFileSync(configPath, 'utf-8');
    let parsedConfig = JSON.parse(rawConfig);

    // 環境変数を展開
    parsedConfig = expandEnvVarsRecursive(parsedConfig);

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
