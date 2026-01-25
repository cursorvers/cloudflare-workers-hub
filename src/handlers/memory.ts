/**
 * Memory Handler - 永続メモリ機能
 *
 * 会話履歴の保存・取得を管理
 */

import { Env } from '../types';

export interface ConversationMessage {
  id: string;
  user_id: string;
  channel: string;
  source: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface UserPreferences {
  user_id: string;
  display_name?: string;
  timezone: string;
  language: string;
  preferences?: Record<string, unknown>;
}

/**
 * 会話履歴を保存
 */
export async function saveConversation(
  env: Env,
  message: ConversationMessage
): Promise<void> {
  if (!env.DB) return;

  const id = message.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  await env.DB.prepare(`
    INSERT INTO conversations (id, user_id, channel, source, role, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    id,
    message.user_id,
    message.channel,
    message.source || 'slack',
    message.role,
    message.content,
    message.metadata ? JSON.stringify(message.metadata) : null
  ).run();
}

/**
 * 最近の会話履歴を取得
 */
export async function getRecentConversations(
  env: Env,
  userId: string,
  channel?: string,
  limit: number = 20
): Promise<ConversationMessage[]> {
  if (!env.DB) return [];

  let query = `
    SELECT id, user_id, channel, source, role, content, metadata, created_at
    FROM conversations
    WHERE user_id = ?
  `;
  const params: (string | number)[] = [userId];

  if (channel) {
    query += ` AND channel = ?`;
    params.push(channel);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const result = await env.DB.prepare(query).bind(...params).all();

  return (result.results || []).reverse().map((row: Record<string, unknown>) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    channel: row.channel as string,
    source: row.source as string,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content as string,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    created_at: row.created_at as string,
  }));
}

/**
 * 会話コンテキストを文字列として取得（Codex注入用）
 */
export async function getConversationContext(
  env: Env,
  userId: string,
  channel?: string,
  maxTokens: number = 2000
): Promise<string> {
  const conversations = await getRecentConversations(env, userId, channel, 30);

  if (conversations.length === 0) {
    return '';
  }

  let context = '## 過去の会話履歴\n\n';
  let tokenEstimate = 0;

  for (const conv of conversations) {
    const line = `[${conv.role}] ${conv.content}\n`;
    const lineTokens = Math.ceil(line.length / 4); // 簡易トークン推定

    if (tokenEstimate + lineTokens > maxTokens) break;

    context += line;
    tokenEstimate += lineTokens;
  }

  return context;
}

/**
 * ユーザー設定を取得
 */
export async function getUserPreferences(
  env: Env,
  userId: string
): Promise<UserPreferences | null> {
  if (!env.DB) return null;

  const result = await env.DB.prepare(`
    SELECT user_id, display_name, timezone, language, preferences
    FROM user_preferences
    WHERE user_id = ?
  `).bind(userId).first();

  if (!result) return null;

  return {
    user_id: result.user_id as string,
    display_name: result.display_name as string | undefined,
    timezone: result.timezone as string,
    language: result.language as string,
    preferences: result.preferences ? JSON.parse(result.preferences as string) : undefined,
  };
}

/**
 * ユーザー設定を保存/更新
 */
export async function saveUserPreferences(
  env: Env,
  prefs: UserPreferences
): Promise<void> {
  if (!env.DB) return;

  await env.DB.prepare(`
    INSERT INTO user_preferences (user_id, display_name, timezone, language, preferences, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      timezone = excluded.timezone,
      language = excluded.language,
      preferences = excluded.preferences,
      updated_at = datetime('now')
  `).bind(
    prefs.user_id,
    prefs.display_name || null,
    prefs.timezone,
    prefs.language,
    prefs.preferences ? JSON.stringify(prefs.preferences) : null
  ).run();
}

/**
 * 古い会話履歴を削除（30日以上前）
 */
export async function cleanupOldConversations(env: Env): Promise<number> {
  if (!env.DB) return 0;

  const result = await env.DB.prepare(`
    DELETE FROM conversations
    WHERE created_at < datetime('now', '-30 days')
    AND expires_at IS NULL
  `).run();

  return result.meta?.changes || 0;
}

export default {
  saveConversation,
  getRecentConversations,
  getConversationContext,
  getUserPreferences,
  saveUserPreferences,
  cleanupOldConversations,
};
