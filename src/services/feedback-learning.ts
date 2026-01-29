/**
 * Feedback Learning Service
 *
 * Strategic Advisor Phase 4: Learning Layer
 *
 * ユーザーのフィードバックパターンを学習し、Insight の優先度を自動調整
 */

import type { Env } from '../types';
import type { InsightType } from '../schemas/strategic-advisor';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const FEEDBACK_KV_PREFIX = 'feedback:';
const LEARNING_KV_PREFIX = 'learning:';
const FEEDBACK_HISTORY_LIMIT = 100;
const LEARNING_DECAY_FACTOR = 0.95; // 古いフィードバックの重みを減衰

// =============================================================================
// Types
// =============================================================================

export interface FeedbackRecord {
  insightId: string;
  insightType: InsightType;
  action: 'accepted' | 'dismissed' | 'snoozed';
  confidence: number;
  timestamp: number;
  goalId?: string;
  ruleId?: string;
}

export interface LearningProfile {
  userId: string;
  updatedAt: number;
  typePreferences: Record<InsightType, number>; // -1 to 1 scale
  confidenceThreshold: number; // User's effective threshold
  engagementRate: number; // 0 to 1
  feedbackCount: number;
  recentActions: Array<{
    action: 'accepted' | 'dismissed' | 'snoozed';
    count: number;
  }>;
}

export interface PriorityAdjustment {
  multiplier: number; // 0.5 to 1.5
  reason: string;
}

// =============================================================================
// Feedback Recording
// =============================================================================

export async function recordFeedback(
  env: Env,
  userId: string,
  feedback: FeedbackRecord
): Promise<void> {
  const kv = env.CACHE;
  if (!kv) {
    safeLog.warn('[Feedback] KV not available');
    return;
  }

  const key = `${FEEDBACK_KV_PREFIX}${userId}`;

  try {
    // Get existing feedback history
    const existing = await kv.get<FeedbackRecord[]>(key, 'json') || [];

    // Add new feedback
    existing.unshift(feedback);

    // Trim to limit
    const trimmed = existing.slice(0, FEEDBACK_HISTORY_LIMIT);

    // Save with 30-day TTL
    await kv.put(key, JSON.stringify(trimmed), {
      expirationTtl: 30 * 24 * 60 * 60,
    });

    safeLog.log('[Feedback] Recorded', {
      userId,
      action: feedback.action,
      insightType: feedback.insightType,
    });

    // Trigger learning update (async, don't wait)
    updateLearningProfile(env, userId, trimmed).catch(err => {
      safeLog.error('[Feedback] Learning update failed', { error: String(err) });
    });
  } catch (error) {
    safeLog.error('[Feedback] Failed to record', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// =============================================================================
// Learning Profile Management
// =============================================================================

async function updateLearningProfile(
  env: Env,
  userId: string,
  feedbackHistory: FeedbackRecord[]
): Promise<void> {
  const kv = env.CACHE;
  if (!kv) return;

  const key = `${LEARNING_KV_PREFIX}${userId}`;

  // Calculate type preferences
  const typePreferences: Record<InsightType, number> = {
    strategic: 0,
    tactical: 0,
    reflective: 0,
    questioning: 0,
  };

  const typeCounts: Record<InsightType, { accepted: number; dismissed: number; total: number }> = {
    strategic: { accepted: 0, dismissed: 0, total: 0 },
    tactical: { accepted: 0, dismissed: 0, total: 0 },
    reflective: { accepted: 0, dismissed: 0, total: 0 },
    questioning: { accepted: 0, dismissed: 0, total: 0 },
  };

  // Calculate with time decay
  let totalWeight = 0;
  feedbackHistory.forEach((fb, index) => {
    const weight = Math.pow(LEARNING_DECAY_FACTOR, index);
    totalWeight += weight;

    typeCounts[fb.insightType].total += weight;
    if (fb.action === 'accepted') {
      typeCounts[fb.insightType].accepted += weight;
    } else if (fb.action === 'dismissed') {
      typeCounts[fb.insightType].dismissed += weight;
    }
  });

  // Convert to preference scores (-1 to 1)
  for (const type of Object.keys(typePreferences) as InsightType[]) {
    const counts = typeCounts[type];
    if (counts.total > 0) {
      // More accepts = positive preference, more dismisses = negative
      typePreferences[type] = (counts.accepted - counts.dismissed) / counts.total;
    }
  }

  // Calculate engagement rate
  const actionCounts = { accepted: 0, dismissed: 0, snoozed: 0 };
  feedbackHistory.slice(0, 20).forEach(fb => {
    actionCounts[fb.action]++;
  });

  const recentTotal = actionCounts.accepted + actionCounts.dismissed + actionCounts.snoozed;
  const engagementRate = recentTotal > 0
    ? (actionCounts.accepted + actionCounts.snoozed * 0.5) / recentTotal
    : 0.5;

  // Calculate effective confidence threshold
  // Based on the average confidence of accepted vs dismissed insights
  let acceptedConfidenceSum = 0;
  let acceptedCount = 0;
  let dismissedConfidenceSum = 0;
  let dismissedCount = 0;

  feedbackHistory.forEach(fb => {
    if (fb.action === 'accepted') {
      acceptedConfidenceSum += fb.confidence;
      acceptedCount++;
    } else if (fb.action === 'dismissed') {
      dismissedConfidenceSum += fb.confidence;
      dismissedCount++;
    }
  });

  const avgAcceptedConfidence = acceptedCount > 0 ? acceptedConfidenceSum / acceptedCount : 70;
  const avgDismissedConfidence = dismissedCount > 0 ? dismissedConfidenceSum / dismissedCount : 50;
  const confidenceThreshold = (avgAcceptedConfidence + avgDismissedConfidence) / 2;

  const profile: LearningProfile = {
    userId,
    updatedAt: Date.now(),
    typePreferences,
    confidenceThreshold,
    engagementRate,
    feedbackCount: feedbackHistory.length,
    recentActions: [
      { action: 'accepted', count: actionCounts.accepted },
      { action: 'dismissed', count: actionCounts.dismissed },
      { action: 'snoozed', count: actionCounts.snoozed },
    ],
  };

  await kv.put(key, JSON.stringify(profile), {
    expirationTtl: 90 * 24 * 60 * 60, // 90 days
  });

  safeLog.log('[Learning] Profile updated', {
    userId,
    feedbackCount: feedbackHistory.length,
    engagementRate: Math.round(engagementRate * 100),
  });
}

// =============================================================================
// Priority Adjustment
// =============================================================================

export async function getLearningProfile(
  env: Env,
  userId: string
): Promise<LearningProfile | null> {
  const kv = env.CACHE;
  if (!kv) return null;

  const key = `${LEARNING_KV_PREFIX}${userId}`;
  return kv.get<LearningProfile>(key, 'json');
}

export function calculatePriorityAdjustment(
  profile: LearningProfile | null,
  insightType: InsightType,
  baseConfidence: number
): PriorityAdjustment {
  if (!profile || profile.feedbackCount < 5) {
    // Not enough data yet
    return { multiplier: 1.0, reason: 'Insufficient feedback data' };
  }

  let multiplier = 1.0;
  const reasons: string[] = [];

  // Adjust based on type preference
  const typePreference = profile.typePreferences[insightType];
  if (typePreference > 0.3) {
    multiplier *= 1.2;
    reasons.push(`User prefers ${insightType} insights`);
  } else if (typePreference < -0.3) {
    multiplier *= 0.8;
    reasons.push(`User often dismisses ${insightType} insights`);
  }

  // Adjust based on confidence threshold
  if (baseConfidence < profile.confidenceThreshold - 10) {
    multiplier *= 0.9;
    reasons.push('Below user\'s typical acceptance threshold');
  } else if (baseConfidence > profile.confidenceThreshold + 10) {
    multiplier *= 1.1;
    reasons.push('Above user\'s typical acceptance threshold');
  }

  // Adjust based on engagement rate
  if (profile.engagementRate < 0.3) {
    // User dismisses a lot - be more selective
    multiplier *= 0.85;
    reasons.push('User has low engagement rate');
  } else if (profile.engagementRate > 0.7) {
    // User engages well - can show more
    multiplier *= 1.1;
    reasons.push('User has high engagement rate');
  }

  // Clamp to reasonable range
  multiplier = Math.max(0.5, Math.min(1.5, multiplier));

  return {
    multiplier,
    reason: reasons.length > 0 ? reasons.join('; ') : 'Standard priority',
  };
}

// =============================================================================
// Insight Filtering based on Learning
// =============================================================================

export async function filterInsightsByLearning(
  env: Env,
  userId: string,
  insights: Array<{ type: InsightType; confidence: number; [key: string]: unknown }>
): Promise<Array<{ type: InsightType; confidence: number; adjustedPriority: number; [key: string]: unknown }>> {
  const profile = await getLearningProfile(env, userId);

  return insights.map(insight => {
    const adjustment = calculatePriorityAdjustment(
      profile,
      insight.type,
      insight.confidence
    );

    return {
      ...insight,
      adjustedPriority: Math.round(insight.confidence * adjustment.multiplier),
    };
  }).sort((a, b) => b.adjustedPriority - a.adjustedPriority);
}

// =============================================================================
// Analytics
// =============================================================================

export async function getFeedbackAnalytics(
  env: Env,
  userId: string
): Promise<{
  totalFeedback: number;
  acceptRate: number;
  dismissRate: number;
  snoozeRate: number;
  preferredTypes: InsightType[];
  dislikedTypes: InsightType[];
} | null> {
  const profile = await getLearningProfile(env, userId);
  if (!profile) return null;

  const totalRecent = profile.recentActions.reduce((sum, a) => sum + a.count, 0);

  const preferredTypes = (Object.entries(profile.typePreferences) as [InsightType, number][])
    .filter(([, pref]) => pref > 0.2)
    .sort((a, b) => b[1] - a[1])
    .map(([type]) => type);

  const dislikedTypes = (Object.entries(profile.typePreferences) as [InsightType, number][])
    .filter(([, pref]) => pref < -0.2)
    .sort((a, b) => a[1] - b[1])
    .map(([type]) => type);

  return {
    totalFeedback: profile.feedbackCount,
    acceptRate: totalRecent > 0
      ? profile.recentActions.find(a => a.action === 'accepted')!.count / totalRecent
      : 0,
    dismissRate: totalRecent > 0
      ? profile.recentActions.find(a => a.action === 'dismissed')!.count / totalRecent
      : 0,
    snoozeRate: totalRecent > 0
      ? profile.recentActions.find(a => a.action === 'snoozed')!.count / totalRecent
      : 0,
    preferredTypes,
    dislikedTypes,
  };
}
