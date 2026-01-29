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
  TASK_COORDINATOR?: DurableObjectNamespace;
  COCKPIT_WS?: DurableObjectNamespace;
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
  // Notifications (Heartbeat pattern)
  DISCORD_WEBHOOK_URL?: string;    // Discord webhook URL for digest/alert notifications
  // Supabase (Limitless pipeline storage)
  SUPABASE_URL?: string;           // Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY?: string; // Supabase service role key (server-side only)
  // OpenAI (optional, for higher-quality lifelog processing)
  OPENAI_API_KEY?: string;         // GPT-4o-mini for classification/summarization
  // Google Slides (optional, for auto-generating slides from digests)
  GOOGLE_CLIENT_ID?: string;       // Google OAuth client ID
  GOOGLE_CLIENT_SECRET?: string;   // Google OAuth client secret
  GOOGLE_REFRESH_TOKEN?: string;   // Google OAuth refresh token
  GOOGLE_SHARE_EMAIL?: string;     // Email to share generated slides with
  GCP_PROJECT_ID?: string;         // GCP project ID (for quota attribution)
  SLIDES_AUTO_GENERATE?: string;   // Enable/disable auto slide generation (default: false)
  // JWT Authentication (Cockpit API)
  JWT_SECRET?: string;             // HS256 secret for development
  JWT_PRIVATE_KEY?: string;        // RS256 private key for production
  JWT_PUBLIC_KEY?: string;         // RS256 public key for production
  // Cloudflare Access (Zero Trust)
  CF_ACCESS_TEAM?: string;         // Cloudflare Access team domain (e.g., "masa-stage1")
  CF_ACCESS_AUD?: string;          // Application AUD tag from Access dashboard
}
