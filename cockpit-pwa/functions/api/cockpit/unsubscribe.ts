/**
 * Push Notification Unsubscribe Handler
 *
 * Removes push subscription from D1 database.
 */

import { deletePushSubscription } from '../../lib/push-repository';

interface Env {
  DB: D1Database;
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
}) {
  try {
    const body = await context.request.json();

    // Validate request
    if (!body.endpoint) {
      return new Response(
        JSON.stringify({
          error: 'Missing endpoint',
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

    // Delete from D1
    await deletePushSubscription(context.env.DB, body.endpoint);

    console.log('[Push] Subscription removed:', {
      endpoint: body.endpoint.substring(0, 50) + '...',
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Subscription removed',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  } catch (error) {
    console.error('[Push] Unsubscribe error:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to process unsubscribe',
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

