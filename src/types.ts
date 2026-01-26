/**
 * Shared types for Cloudflare Workers Hub
 */

export interface WebhookEvent {
  source: 'slack' | 'discord' | 'clawdbot' | 'github' | 'stripe' | 'unknown';
  type: string;
  payload: unknown;
  timestamp: string;
}

export interface NormalizedEvent {
  id: string;
  source: string;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
  requiresOrchestrator: boolean;
}

export interface Env {
  AI: Ai;
  DB?: D1Database;
  CACHE?: KVNamespace;
  AUDIO_STAGING?: R2Bucket;
  OBSIDIAN_VAULT?: R2Bucket;
  KNOWLEDGE_INDEX?: VectorizeIndex;
  ENVIRONMENT: string;
  // Slack
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  // Discord
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  // Telegram
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_SECRET_TOKEN?: string; // For webhook signature verification
  // WhatsApp Business API
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_APP_SECRET?: string; // For webhook HMAC verification
  // Monitoring
  SENTRY_DSN?: string;
  // AI Assistant Daemon - Scoped API Keys
  ASSISTANT_API_KEY?: string;      // Legacy: falls back if scoped keys not set
  QUEUE_API_KEY?: string;          // /api/queue, /api/result endpoints
  MEMORY_API_KEY?: string;         // /api/memory endpoints
  ADMIN_API_KEY?: string;          // /api/admin endpoints (future)
  MONITORING_API_KEY?: string;     // /health, /metrics endpoints
  // Limitless.ai Integration
  LIMITLESS_API_KEY?: string;      // Limitless.ai API key for Pendant sync
  LIMITLESS_USER_ID?: string;      // User ID for automatic sync
  LIMITLESS_AUTO_SYNC_ENABLED?: string; // Enable/disable auto-sync (default: false)
  LIMITLESS_SYNC_INTERVAL_HOURS?: string; // Sync interval in hours (default: 1)
  // Supabase (Limitless pipeline storage)
  SUPABASE_URL?: string;           // Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY?: string; // Supabase service role key (server-side only)
}
