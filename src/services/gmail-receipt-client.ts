/**
 * Gmail Receipt Client (OAuth 2.0 Refresh Token)
 *
 * Fetch emails with PDF attachments for receipt processing.
 * Uses OAuth 2.0 Refresh Token for automated access.
 */

import { z } from 'zod';
import { decodeBase64UrlToUint8Array } from '../utils/base64url';

// ============================================================================
// Schemas
// ============================================================================

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

const MessagePartSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    body: z.object({
      attachmentId: z.string().optional(),
      size: z.number().optional(),
      data: z.string().optional(),
    }).optional(),
    parts: z.array(MessagePartSchema).optional(),
  })
);

const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  payload: z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })),
    body: z.object({
      attachmentId: z.string().optional(),
      size: z.number().optional(),
      data: z.string().optional(),
    }).optional(),
    parts: z.array(MessagePartSchema).optional(),
  }).optional(),
  internalDate: z.string(),
});

export type GmailMessage = z.infer<typeof MessageSchema>;
export type MessagePart = z.infer<typeof MessagePartSchema>;

const MessagesListResponseSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    threadId: z.string(),
  })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

const AttachmentResponseSchema = z.object({
  size: z.number(),
  data: z.string(), // Base64url encoded
});

// ============================================================================
// Types
// ============================================================================

export interface GmailReceiptAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array; // Decoded binary data
  size: number;
  attachmentId: string;
}

export interface GmailReceiptEmail {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: Date;
  attachments: GmailReceiptAttachment[];
}

export interface GmailHtmlBody {
  html: string;
  plainText: string | null;
  hasExternalReferences: boolean;
  externalRefTypes: string[]; // e.g., ['img', 'link', 'import']
}

export interface GmailHtmlReceiptEmail {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: Date;
  htmlBody: GmailHtmlBody;
}

export type ShouldDownloadAttachment = (args: {
  messageId: string;
  attachmentId: string;
  filename: string;
  size?: number;
}) => Promise<boolean> | boolean;

// ============================================================================
// Constants
// ============================================================================

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ============================================================================
// Token Management
// ============================================================================

/**
 * Refresh access token using refresh token.
 */
async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const parsed = TokenResponseSchema.parse(data);
  return parsed.access_token;
}

// ============================================================================
// Gmail API Methods
// ============================================================================

/**
 * Search for messages with PDF attachments.
 */
async function searchMessages(
  accessToken: string,
  query: string,
  maxResults: number = 10
): Promise<Array<{ id: string; threadId: string }>> {
  const url = `${GMAIL_API_BASE}/users/me/messages?` +
    new URLSearchParams({
      q: query,
      maxResults: maxResults.toString(),
    }).toString();

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Gmail search failed: ${response.status}`);
  }

  const data = await response.json();
  const parsed = MessagesListResponseSchema.parse(data);
  return parsed.messages || [];
}

/**
 * Get full message details.
 */
async function getMessage(
  accessToken: string,
  messageId: string
): Promise<GmailMessage> {
  const url = `${GMAIL_API_BASE}/users/me/messages/${messageId}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Gmail getMessage failed: ${response.status}`);
  }

  const data = await response.json();
  return MessageSchema.parse(data);
}

/**
 * Download attachment.
 */
async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string
): Promise<Uint8Array> {
  const url = `${GMAIL_API_BASE}/users/me/messages/${messageId}/attachments/${attachmentId}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Gmail getAttachment failed: ${response.status}`);
  }

  const data = await response.json();
  const parsed = AttachmentResponseSchema.parse(data);

  return decodeBase64UrlToUint8Array(parsed.data);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract all PDF attachments from a message.
 */
async function extractPDFAttachments(
  accessToken: string,
  message: GmailMessage,
  shouldDownloadAttachment?: ShouldDownloadAttachment
): Promise<GmailReceiptAttachment[]> {
  const attachments: GmailReceiptAttachment[] = [];

  const processPart = async (part: MessagePart) => {
    // Check if this part is a PDF attachment
    if (
      part.filename &&
      part.filename.toLowerCase().endsWith('.pdf') &&
      part.body?.attachmentId
    ) {
      try {
        if (shouldDownloadAttachment) {
          const ok = await shouldDownloadAttachment({
            messageId: message.id,
            attachmentId: part.body.attachmentId,
            filename: part.filename,
            size: part.body.size,
          });
          if (!ok) {
            return;
          }
        }
        const data = await getAttachment(
          accessToken,
          message.id,
          part.body.attachmentId
        );

        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || 'application/pdf',
          data,
          size: part.body.size || data.length,
          attachmentId: part.body.attachmentId,
        });
      } catch (error) {
        console.error(`Failed to download attachment ${part.filename}:`, error);
      }
    }

    // Recursively process nested parts
    if (part.parts) {
      for (const subPart of part.parts) {
        await processPart(subPart);
      }
    }
  };

  // Process all parts
  if (message.payload?.parts) {
    for (const part of message.payload.parts) {
      await processPart(part);
    }
  }

  // Check if the message itself is an attachment
  if (
    message.payload?.filename &&
    message.payload.filename.toLowerCase().endsWith('.pdf') &&
    message.payload.body?.attachmentId
  ) {
    try {
      if (shouldDownloadAttachment) {
        const ok = await shouldDownloadAttachment({
          messageId: message.id,
          attachmentId: message.payload.body.attachmentId,
          filename: message.payload.filename,
          size: message.payload.body.size,
        });
        if (!ok) {
          return attachments;
        }
      }
      const data = await getAttachment(
        accessToken,
        message.id,
        message.payload.body.attachmentId
      );

      attachments.push({
        filename: message.payload.filename,
        mimeType: message.payload.mimeType || 'application/pdf',
        data,
        size: message.payload.body.size || data.length,
        attachmentId: message.payload.body.attachmentId,
      });
    } catch (error) {
      console.error(`Failed to download message attachment:`, error);
    }
  }

  return attachments;
}

// ============================================================================
// HTML Body Extraction
// ============================================================================

/**
 * Detect external references in HTML that could compromise reproducibility.
 * Returns list of detected reference types.
 */
function detectExternalReferences(html: string): string[] {
  const types: string[] = [];

  // <img src="http(s)://..."> (skip data: URIs and cid: references)
  if (/<img[^>]+src\s*=\s*["']https?:\/\//i.test(html)) {
    types.push('img');
  }

  // <link href="http(s)://..."> (external stylesheets)
  if (/<link[^>]+href\s*=\s*["']https?:\/\//i.test(html)) {
    types.push('link');
  }

  // @import url("http(s)://...")
  if (/@import\s+(?:url\s*\()?["']?https?:\/\//i.test(html)) {
    types.push('import');
  }

  // <script src="..."> (should never be trusted)
  if (/<script[^>]+src\s*=\s*["']/i.test(html)) {
    types.push('script');
  }

  return types;
}

/**
 * Strip HTML tags to extract plain text for AI classification.
 * Preserves structural whitespace from block elements.
 */
export function stripHtmlTags(html: string): string {
  return html
    // Remove script/style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Block elements → newline
    .replace(/<\/(p|div|tr|li|h[1-6]|br\s*\/?)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&yen;/g, '¥')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract HTML and plain text bodies from a Gmail message.
 * Walks MIME multipart tree to find text/html and text/plain parts.
 */
function extractHtmlBody(message: GmailMessage): GmailHtmlBody | null {
  let htmlContent: string | null = null;
  let plainContent: string | null = null;

  const processPart = (part: MessagePart): void => {
    const mimeType = (part.mimeType || '').toLowerCase();

    if (mimeType === 'text/html' && part.body?.data && !htmlContent) {
      const decoded = decodeBase64UrlToUint8Array(part.body.data);
      htmlContent = new TextDecoder().decode(decoded);
    }

    if (mimeType === 'text/plain' && part.body?.data && !plainContent) {
      const decoded = decodeBase64UrlToUint8Array(part.body.data);
      plainContent = new TextDecoder().decode(decoded);
    }

    if (part.parts) {
      for (const subPart of part.parts) {
        processPart(subPart);
      }
    }
  };

  // Check top-level payload body
  if (message.payload) {
    const topMime = (message.payload.mimeType || '').toLowerCase();
    if (topMime === 'text/html' && message.payload.body?.data) {
      const decoded = decodeBase64UrlToUint8Array(message.payload.body.data);
      htmlContent = new TextDecoder().decode(decoded);
    }
    if (topMime === 'text/plain' && message.payload.body?.data) {
      const decoded = decodeBase64UrlToUint8Array(message.payload.body.data);
      plainContent = new TextDecoder().decode(decoded);
    }

    // Walk multipart tree
    if (message.payload.parts) {
      for (const part of message.payload.parts) {
        processPart(part);
      }
    }
  }

  if (!htmlContent && !plainContent) {
    return null;
  }

  const html = htmlContent || '';
  const externalRefTypes = html ? detectExternalReferences(html) : [];

  return {
    html,
    plainText: plainContent,
    hasExternalReferences: externalRefTypes.length > 0,
    externalRefTypes,
  };
}

/**
 * Extract email metadata.
 */
function extractMetadata(message: GmailMessage): {
  subject: string;
  from: string;
  date: Date;
} {
  const headers = message.payload?.headers || [];
  const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
  const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');

  return {
    subject: subjectHeader?.value || '(No subject)',
    from: fromHeader?.value || '(Unknown)',
    date: new Date(Number(message.internalDate)),
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Fetch recent emails with PDF attachments.
 *
 * @param config - OAuth credentials
 * @param options - Search options
 * @returns Array of emails with PDF attachments
 */
export async function fetchReceiptEmails(
  config: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  },
  options: {
    query?: string;
    maxResults?: number;
    newerThan?: string; // e.g., "1d", "2h"
    shouldDownloadAttachment?: ShouldDownloadAttachment;
  } = {}
): Promise<GmailReceiptEmail[]> {
  const { clientId, clientSecret, refreshToken } = config;
  const { query: customQuery, maxResults = 10, newerThan = '2h', shouldDownloadAttachment } = options;

  // Refresh access token
  const accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken);

  // Build search queries
  // Goal: pick up receipts when related JP/EN keywords appear anywhere (subject/body),
  // not only in the subject line. Prefer false positives over false negatives.
  const senderFilter = '(from:billing@cloudflare.com OR from:noreply@github.com OR from:receipts@stripe.com OR from:invoices@stripe.com OR from:noreply@google.com OR from:noreply@anthropic.com OR from:noreply@x.ai OR from:noreply@vercel.com OR from:billing@heroku.com OR from:aws-billing@amazon.com OR from:cloud-noreply@google.com)';
  const negativeFilter = '-in:spam -in:trash';

  const buildKeywordClause = (kw: string): string => {
    const t = String(kw || '').trim();
    const stripped = t.replace(/"/g, '');
    const needsQuote = stripped.includes(' ') || /[^a-zA-Z0-9_-]/.test(stripped);
    return needsQuote ? `"${stripped}"` : stripped;
  };

  let messageRefs: Array<{ id: string; threadId: string }> = [];

  if (customQuery) {
    messageRefs = await searchMessages(accessToken, customQuery, maxResults);
  } else {
    // Split keywords into batches to keep Gmail query URL under ~2000 chars.
    const BATCH_SIZE = 20;
    const keywordClauses = RECEIPT_SUBJECT_KEYWORDS.map(buildKeywordClause);

    const batches: string[][] = [];
    for (let i = 0; i < keywordClauses.length; i += BATCH_SIZE) {
      batches.push(keywordClauses.slice(i, i + BATCH_SIZE));
    }

    // Attach sender filter to the first batch (additive, not restrictive).
    if (batches.length > 0) {
      batches[0] = [...batches[0], senderFilter];
    }

    const suffix = `has:attachment filename:pdf ${negativeFilter} newer_than:${newerThan}`;

    const seen = new Set<string>();
    const allRefs: Array<{ id: string; threadId: string }> = [];

    const batchResults = await Promise.allSettled(
      batches.map(clauses => {
        const query = `(${clauses.join(' OR ')}) ${suffix}`;
        return searchMessages(accessToken, query, maxResults);
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        for (const ref of result.value) {
          if (!seen.has(ref.id)) {
            seen.add(ref.id);
            allRefs.push(ref);
          }
        }
      }
      // Silently skip failed batches — partial results are acceptable
    }

    // Enforce maxResults after dedup to cap downstream message/attachment fetch cost.
    messageRefs = allRefs.slice(0, maxResults);
  }

  if (messageRefs.length === 0) {
    return [];
  }

  // Fetch full message details and extract attachments
  const emails: GmailReceiptEmail[] = [];

  for (const ref of messageRefs) {
    try {
      const message = await getMessage(accessToken, ref.id);
      const attachments = await extractPDFAttachments(accessToken, message, shouldDownloadAttachment);

      if (attachments.length > 0) {
        const metadata = extractMetadata(message);
        emails.push({
          messageId: message.id,
          threadId: message.threadId,
          ...metadata,
          attachments,
        });
      }
    } catch (error) {
      console.error(`Failed to process message ${ref.id}:`, error);
    }
  }

  return emails;
}

/**
 * Subject keywords for detecting receipt/invoice emails (broad matching).
 * Prefers false positives over false negatives.
 * Used by both PDF attachment search and HTML body search.
 */
const RECEIPT_SUBJECT_KEYWORDS = [
  // --- Japanese ---
  // 領収書・レシート
  '領収', '領収書', '領収証',
  // 請求書
  '請求', '請求書', 'ご請求',
  // 支払い・決済
  'お支払い', 'お支払', '支払い完了', '決済完了', '決済',
  'ご入金', '引き落とし', '振込', '振替',
  // 利用明細・ご利用
  'ご利用明細', 'ご利用', '利用明細', 'ご利用額',
  // 注文・購入
  '注文確認', 'ご注文', '購入', '購入完了', 'お買い上げ',
  // サブスクリプション・定期課金
  '月額', '年額', '定期', 'サブスクリプション', '更新', '自動更新',
  'プラン', '契約',
  // 見積・納品
  '見積', '見積書', '納品書',

  // --- English ---
  // Receipt / Invoice
  'receipt', 'invoice', 'tax invoice',
  // Billing / Payment
  'billing', 'payment', 'payment confirmation', 'payment received',
  'charge', 'transaction',
  // Statement / Summary
  'statement', 'account statement', 'billing statement',
  // Order / Purchase
  'order confirmation', 'your order', 'purchase', 'purchase confirmation',
  // Subscription
  'subscription', 'renewal', 'plan', 'membership',
  'your plan', 'auto-renewal',
  // Thank you (common receipt subject pattern)
  'thank you for your payment', 'thanks for your order',
  'thank you for your purchase',
] as const;

/**
 * Fetch recent HTML receipt emails (no PDF attachment required).
 * Uses broad keyword matching across subject/body — prefers over-capture.
 * Excludes emails that already have PDF attachments (handled by fetchReceiptEmails).
 *
 * @param config - OAuth credentials
 * @param options - Search options
 * @returns Array of emails with HTML bodies
 */
export async function fetchHtmlReceiptEmails(
  config: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  },
  options: {
    senderAllowlist?: string[];   // Optional: if provided, also match these senders
    maxResults?: number;
    newerThan?: string;
  } = {}
): Promise<GmailHtmlReceiptEmail[]> {
  const { clientId, clientSecret, refreshToken } = config;
  const { senderAllowlist = [], maxResults = 10, newerThan = '2h' } = options;

  const accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken);

  // Split keywords into batches to keep Gmail query URL under ~2000 chars.
  // A single query with 60+ OR clauses produces URLs >2400 chars which can
  // cause silent failures in some HTTP stacks.
  const BATCH_SIZE = 20;
  const negativeFilter = '-in:spam -in:trash';

  const buildKeywordClause = (kw: string): string => {
    const t = String(kw || '').trim();
    const stripped = t.replace(/"/g, '');
    const needsQuote = stripped.includes(' ') || /[^a-zA-Z0-9_-]/.test(stripped);
    return needsQuote ? `"${stripped}"` : stripped;
  };

  const keywordClauses = RECEIPT_SUBJECT_KEYWORDS.map(buildKeywordClause);
  const senderClauses = senderAllowlist.filter(Boolean).map(s => `from:${s}`);

  // Build batched queries: each batch has ≤BATCH_SIZE keyword clauses.
  // Sender clauses go into the first batch (they're few).
  const batches: string[][] = [];
  for (let i = 0; i < keywordClauses.length; i += BATCH_SIZE) {
    batches.push(keywordClauses.slice(i, i + BATCH_SIZE));
  }
  // Attach sender clauses to the first batch
  if (senderClauses.length > 0 && batches.length > 0) {
    batches[0] = [...batches[0], ...senderClauses];
  }

  // Use -filename:pdf instead of -has:attachment because Stripe/SaaS receipt
  // emails embed inline images (logos) that Gmail counts as "attachments".
  const suffix = `-filename:pdf ${negativeFilter} newer_than:${newerThan}`;

  // Search all batches in parallel, collect unique message IDs
  const seen = new Set<string>();
  const allRefs: Array<{ id: string; threadId: string }> = [];

  const batchResults = await Promise.allSettled(
    batches.map(clauses => {
      const query = `(${clauses.join(' OR ')}) ${suffix}`;
      return searchMessages(accessToken, query, maxResults);
    })
  );

  for (const result of batchResults) {
    if (result.status === 'fulfilled') {
      for (const ref of result.value) {
        if (!seen.has(ref.id)) {
          seen.add(ref.id);
          allRefs.push(ref);
        }
      }
    }
    // Silently skip failed batches — partial results are acceptable
  }

  if (allRefs.length === 0) {
    return [];
  }

  // Limit to maxResults after dedup
  const refs = allRefs.slice(0, maxResults);
  const emails: GmailHtmlReceiptEmail[] = [];

  for (const ref of refs) {
    try {
      const message = await getMessage(accessToken, ref.id);
      const htmlBody = extractHtmlBody(message);

      if (htmlBody && (htmlBody.html || htmlBody.plainText)) {
        const metadata = extractMetadata(message);
        emails.push({
          messageId: message.id,
          threadId: message.threadId,
          ...metadata,
          htmlBody,
        });
      }
    } catch (error) {
      console.error(`Failed to process HTML message ${ref.id}:`, error);
    }
  }

  return emails;
}

