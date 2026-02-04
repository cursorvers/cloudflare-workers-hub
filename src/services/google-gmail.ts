/**
 * Google Gmail API Client
 *
 * Fetch recent important emails from Gmail.
 * Used for HEARTBEAT.md morning/midday checks.
 *
 * No npm dependencies — fetch-based, Zod validation, google-auth integration.
 */

import { z } from 'zod';

// ============================================================================
// Schemas
// ============================================================================

const MessageHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const MessagePartSchema = z.object({
  mimeType: z.string().optional(),
  body: z.object({
    data: z.string().optional(),
  }).optional(),
  parts: z.array(z.any()).optional(),
});

const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string().optional(),
  payload: z.object({
    headers: z.array(MessageHeaderSchema),
    parts: z.array(MessagePartSchema).optional(),
  }).optional(),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});

export type GmailMessage = z.infer<typeof MessageSchema>;

const MessagesListResponseSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    threadId: z.string(),
  })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

// ============================================================================
// Constants
// ============================================================================

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

// ============================================================================
// Public API
// ============================================================================

/**
 * Fetch recent important emails from Gmail.
 *
 * @param options - Query options
 * @returns Array of Gmail messages
 */
export async function getRecentImportantEmails(options: {
  maxResults?: number;
  credentialsPath?: string;
  subject?: string; // Domain-Wide Delegation: email to impersonate
}): Promise<GmailMessage[]> {
  const { maxResults = 10, credentialsPath, subject } = options;

  // For Domain-Wide Delegation, get subject from env var if not provided
  const userEmail = subject || process.env.GOOGLE_CALENDAR_USER_EMAIL;

  const credentials = await import('./google-auth').then(m => m.loadGoogleCredentials(credentialsPath));
  const tokenResponse = await import('./google-auth').then(m =>
    m.getAccessToken(
      credentials,
      'https://www.googleapis.com/auth/gmail.readonly',
      userEmail
    )
  );
  const accessToken = tokenResponse.access_token;

  // Search for important unread emails from the last 24 hours
  const query = 'is:important is:unread newer_than:1d';

  const listUrl = `${GMAIL_API_BASE}/users/me/messages?` +
    new URLSearchParams({
      q: query,
      maxResults: maxResults.toString(),
    }).toString();

  const listResponse = await fetch(listUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!listResponse.ok) {
    const errorText = await listResponse.text();
    throw new Error(
      `Gmail API list error (${listResponse.status}): ${errorText.substring(0, 300)}`
    );
  }

  const listData = await listResponse.json();
  const parsed = MessagesListResponseSchema.parse(listData);

  if (!parsed.messages || parsed.messages.length === 0) {
    return [];
  }

  // Fetch full message details for each message
  const messages: GmailMessage[] = [];
  for (const msgRef of parsed.messages) {
    const msgUrl = `${GMAIL_API_BASE}/users/me/messages/${msgRef.id}`;
    const msgResponse = await fetch(msgUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (!msgResponse.ok) {
      continue; // Skip failed messages
    }

    const msgData = await msgResponse.json();
    const message = MessageSchema.parse(msgData);
    messages.push(message);
  }

  return messages;
}

/**
 * Extract email subject from message headers.
 */
export function getSubject(message: GmailMessage): string {
  const subjectHeader = message.payload?.headers?.find(h => h.name.toLowerCase() === 'subject');
  return subjectHeader?.value || '(No subject)';
}

/**
 * Extract email sender from message headers.
 */
export function getFrom(message: GmailMessage): string {
  const fromHeader = message.payload?.headers?.find(h => h.name.toLowerCase() === 'from');
  return fromHeader?.value || '(Unknown sender)';
}

/**
 * Extract email date from message headers.
 */
export function getDate(message: GmailMessage): string {
  const dateHeader = message.payload?.headers?.find(h => h.name.toLowerCase() === 'date');
  if (dateHeader?.value) {
    return new Date(dateHeader.value).toLocaleString('ja-JP', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  if (message.internalDate) {
    return new Date(Number(message.internalDate)).toLocaleString('ja-JP', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return '(No date)';
}

/**
 * Format email for display in HEARTBEAT suggestions.
 *
 * @param message - Gmail message
 * @returns Formatted string
 */
export function formatEmailForDisplay(message: GmailMessage): string {
  const subject = getSubject(message);
  const from = getFrom(message);
  const date = getDate(message);
  const snippet = message.snippet ? ` - ${message.snippet.substring(0, 80)}...` : '';

  return `[${date}] ${from}: ${subject}${snippet}`;
}

/**
 * Get summary of important unread emails for HEARTBEAT.md.
 *
 * @param maxResults - Maximum number of emails to fetch
 * @param credentialsPath - Optional path to credentials file
 * @returns Formatted summary string
 */
export async function getImportantEmailsSummary(
  maxResults: number = 5,
  credentialsPath?: string
): Promise<string> {
  const emails = await getRecentImportantEmails({ maxResults, credentialsPath });

  if (emails.length === 0) {
    return '重要な未読メールはありません。';
  }

  const formattedEmails = emails.map(formatEmailForDisplay);

  return `重要な未読メール（${formattedEmails.length}件）:\n${formattedEmails.map(e => `  • ${e}`).join('\n')}`;
}
