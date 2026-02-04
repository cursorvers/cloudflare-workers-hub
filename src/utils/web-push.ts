/**
 * Web Push Utilities
 *
 * Implements Web Push Protocol (RFC 8030) for sending push notifications.
 * Used by both push-notifications.ts and push-queue-consumer.ts.
 */

import { createVapidHeaders } from './vapid';

/**
 * Custom error class for Web Push failures with HTTP status code
 */
export class WebPushError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public statusText: string
  ) {
    super(message);
    this.name = 'WebPushError';
  }
}

/**
 * Send a Web Push notification to a subscription endpoint
 *
 * Implements Web Push Protocol (RFC 8030)
 */
export async function sendWebPush(
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  },
  payload: string,
  vapidPrivateKey: string,
  vapidPublicKey: string,
  vapidSubject: string
): Promise<void> {
  const audience = new URL(subscription.endpoint).origin;
  const { authorization, cryptoKey } = await createVapidHeaders({
    audience,
    subject: vapidSubject,
    publicKey: vapidPublicKey,
    privateKey: vapidPrivateKey,
  });

  const vapidHeaders = {
    'Content-Type': 'application/json',
    'TTL': '3600',
    'Urgency': 'high',
    'Authorization': authorization,
    'Crypto-Key': cryptoKey,
  };

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: vapidHeaders,
    body: payload,
  });

  if (!response.ok) {
    throw new WebPushError(
      `Push failed: ${response.status} ${response.statusText}`,
      response.status,
      response.statusText
    );
  }
}
