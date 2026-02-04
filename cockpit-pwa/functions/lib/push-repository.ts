/**
 * Push Subscription Repository
 *
 * Shared data layer for push notification subscriptions.
 * Uses D1 HTTP API for lightweight Pages Functions integration.
 */

export interface PushSubscriptionData {
  endpoint: string;
  auth: string;
  p256dh: string;
  userId?: string;
}

export interface D1Binding {
  prepare: (sql: string) => {
    bind: (...args: any[]) => {
      run: () => Promise<{ success: boolean }>;
      first: () => Promise<any>;
    };
  };
}

/**
 * Save push subscription to D1 (idempotent)
 * If subscription with same endpoint exists, update it.
 */
export async function savePushSubscription(
  db: D1Binding,
  data: PushSubscriptionData
): Promise<void> {
  const { endpoint, auth, p256dh, userId } = data;
  const createdAt = Date.now();

  // Upsert: INSERT OR REPLACE
  await db
    .prepare(`
      INSERT INTO push_subscriptions (endpoint, auth, p256dh, user_id, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(endpoint)
      DO UPDATE SET auth = ?2, p256dh = ?3, user_id = ?4
    `)
    .bind(endpoint, auth, p256dh, userId || null, createdAt)
    .run();
}

/**
 * Delete push subscription by endpoint
 */
export async function deletePushSubscription(
  db: D1Binding,
  endpoint: string
): Promise<void> {
  await db
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1')
    .bind(endpoint)
    .run();
}

/**
 * Get push subscription by endpoint
 */
export async function getPushSubscription(
  db: D1Binding,
  endpoint: string
): Promise<PushSubscriptionData | null> {
  const result = await db
    .prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1')
    .bind(endpoint)
    .first();

  if (!result) {
    return null;
  }

  return {
    endpoint: result.endpoint,
    auth: result.auth,
    p256dh: result.p256dh,
    userId: result.user_id || undefined,
  };
}
