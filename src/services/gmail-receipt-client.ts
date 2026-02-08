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
  const { query: customQuery, maxResults = 10, newerThan = '1d', shouldDownloadAttachment } = options;

  // Refresh access token
  const accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken);

  // Build search query
  // Filter for receipt/invoice emails only
  // Strategy: subject keywords + known billing senders (not broad from:noreply)
  const subjectFilter = '(subject:receipt OR subject:invoice OR subject:billing OR subject:payment OR subject:領収 OR subject:請求 OR subject:statement)';
  const senderFilter = '(from:billing@cloudflare.com OR from:noreply@github.com OR from:receipts@stripe.com OR from:invoices@stripe.com OR from:noreply@google.com OR from:noreply@anthropic.com OR from:noreply@x.ai OR from:noreply@vercel.com OR from:billing@heroku.com OR from:aws-billing@amazon.com OR from:cloud-noreply@google.com)';
  const query = customQuery || `has:attachment filename:pdf (${subjectFilter} OR ${senderFilter}) newer_than:${newerThan}`;

  // Search for messages
  const messageRefs = await searchMessages(accessToken, query, maxResults);

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
