/**
 * Push Notification Subscribe Handler
 *
 * Saves push subscription to D1 database (idempotent).
 */

import { savePushSubscription } from '../../lib/push-repository';

interface Env {
  DB: D1Database;
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
}) {
  try {
    const body = await context.request.json();

    // Validate subscription format
    if (!body.subscription?.endpoint || !body.subscription?.keys) {
      return new Response(
        JSON.stringify({
          error: 'Invalid subscription format',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    const { endpoint, keys } = body.subscription;
    const { auth, p256dh } = keys;

    // Validate keys
    if (!auth || !p256dh) {
      return new Response(
        JSON.stringify({
          error: 'Missing auth or p256dh keys',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // Save to D1 (idempotent)
    await savePushSubscription(context.env.DB, {
      endpoint,
      auth,
      p256dh,
      userId: body.userId, // Optional: for multi-user support
    });

    console.log('[Push] Subscription saved:', {
      endpoint: endpoint.substring(0, 50) + '...',
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Subscription saved',
      }),
      {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  } catch (error) {
    console.error('[Push] Subscribe error:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to process subscription',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

