/**
 * Tests for Feedback Learning Service
 *
 * Test Coverage:
 * 1. recordFeedback - feedback recording with KV storage
 * 2. updateLearningProfile - profile calculation with time decay
 * 3. calculatePriorityAdjustment - priority multiplier calculation
 * 4. filterInsightsByLearning - insight filtering and sorting
 * 5. getFeedbackAnalytics - analytics generation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordFeedback,
  getLearningProfile,
  calculatePriorityAdjustment,
  filterInsightsByLearning,
  getFeedbackAnalytics,
  FeedbackRecord,
  LearningProfile,
} from './feedback-learning';
import type { Env } from '../types';
import type { InsightType } from '../schemas/strategic-advisor';

// Mock dependencies
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Helper to create mock Env with KV
function createMockEnv(): Env {
  const kvStore = new Map<string, string>();

  return {
    CACHE: {
      get: vi.fn(async (key: string, type?: string) => {
        const value = kvStore.get(key);
        if (!value) return null;
        return type === 'json' ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key);
      }),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    } as any,
  } as Env;
}

// Helper to create mock feedback records
function createFeedbackRecord(
  overrides: Partial<FeedbackRecord> = {}
): FeedbackRecord {
  return {
    insightId: 'insight-1',
    insightType: 'strategic',
    action: 'accepted',
    confidence: 80,
    timestamp: Date.now(),
    ...overrides,
  };
}

// Helper to create mock learning profile
function createLearningProfile(
  overrides: Partial<LearningProfile> = {}
): LearningProfile {
  return {
    userId: 'user-1',
    updatedAt: Date.now(),
    typePreferences: {
      strategic: 0,
      tactical: 0,
      reflective: 0,
      questioning: 0,
    },
    confidenceThreshold: 60,
    engagementRate: 0.5,
    feedbackCount: 10,
    recentActions: [
      { action: 'accepted', count: 5 },
      { action: 'dismissed', count: 3 },
      { action: 'snoozed', count: 2 },
    ],
    ...overrides,
  };
}

describe('Feedback Learning Service', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
    vi.clearAllMocks();
  });

  describe('recordFeedback', () => {
    it('should record feedback to KV', async () => {
      const feedback = createFeedbackRecord();

      await recordFeedback(env, 'user-1', feedback);

      expect(env.CACHE.put).toHaveBeenCalledWith(
        'feedback:user-1',
        expect.any(String),
        expect.objectContaining({ expirationTtl: expect.any(Number) })
      );
    });

    it('should prepend new feedback to existing history', async () => {
      const existingFeedback = [createFeedbackRecord({ insightId: 'old-1' })];
      vi.mocked(env.CACHE.get).mockResolvedValueOnce(existingFeedback);

      const newFeedback = createFeedbackRecord({ insightId: 'new-1' });
      await recordFeedback(env, 'user-1', newFeedback);

      const putCall = vi.mocked(env.CACHE.put).mock.calls[0];
      const savedData = JSON.parse(putCall[1] as string);
      expect(savedData[0].insightId).toBe('new-1');
      expect(savedData[1].insightId).toBe('old-1');
    });

    it('should trim feedback history to limit', async () => {
      // Create 110 existing feedbacks (over the 100 limit)
      const existingFeedback = Array.from({ length: 110 }, (_, i) =>
        createFeedbackRecord({ insightId: `existing-${i}` })
      );
      vi.mocked(env.CACHE.get).mockResolvedValueOnce(existingFeedback);

      const newFeedback = createFeedbackRecord({ insightId: 'new-1' });
      await recordFeedback(env, 'user-1', newFeedback);

      const putCall = vi.mocked(env.CACHE.put).mock.calls[0];
      const savedData = JSON.parse(putCall[1] as string);
      expect(savedData.length).toBe(100);
      expect(savedData[0].insightId).toBe('new-1');
    });

    it('should handle missing KV gracefully', async () => {
      const envWithoutKV = { CACHE: undefined } as Env;
      const feedback = createFeedbackRecord();

      // Should not throw
      await expect(
        recordFeedback(envWithoutKV, 'user-1', feedback)
      ).resolves.toBeUndefined();
    });
  });

  describe('getLearningProfile', () => {
    it('should return profile from KV', async () => {
      const profile = createLearningProfile();
      vi.mocked(env.CACHE.get).mockResolvedValueOnce(profile);

      const result = await getLearningProfile(env, 'user-1');

      expect(result).toEqual(profile);
      expect(env.CACHE.get).toHaveBeenCalledWith('learning:user-1', 'json');
    });

    it('should return null when no profile exists', async () => {
      vi.mocked(env.CACHE.get).mockResolvedValueOnce(null);

      const result = await getLearningProfile(env, 'user-1');

      expect(result).toBeNull();
    });

    it('should return null when KV unavailable', async () => {
      const envWithoutKV = { CACHE: undefined } as Env;

      const result = await getLearningProfile(envWithoutKV, 'user-1');

      expect(result).toBeNull();
    });
  });

  describe('calculatePriorityAdjustment', () => {
    it('should return multiplier 1.0 for insufficient feedback', () => {
      const profile = createLearningProfile({ feedbackCount: 3 });

      const result = calculatePriorityAdjustment(profile, 'strategic', 70);

      expect(result.multiplier).toBe(1.0);
      expect(result.reason).toBe('Insufficient feedback data');
    });

    it('should return multiplier 1.0 for null profile', () => {
      const result = calculatePriorityAdjustment(null, 'strategic', 70);

      expect(result.multiplier).toBe(1.0);
    });

    it('should increase multiplier for preferred insight types', () => {
      const profile = createLearningProfile({
        typePreferences: {
          strategic: 0.5, // High preference
          tactical: 0,
          reflective: 0,
          questioning: 0,
        },
        feedbackCount: 10,
      });

      const result = calculatePriorityAdjustment(profile, 'strategic', 70);

      expect(result.multiplier).toBeGreaterThan(1.0);
      expect(result.reason).toContain('prefers strategic');
    });

    it('should decrease multiplier for disliked insight types', () => {
      const profile = createLearningProfile({
        typePreferences: {
          strategic: -0.5, // Low preference
          tactical: 0,
          reflective: 0,
          questioning: 0,
        },
        feedbackCount: 10,
      });

      const result = calculatePriorityAdjustment(profile, 'strategic', 70);

      expect(result.multiplier).toBeLessThan(1.0);
      expect(result.reason).toContain('dismisses strategic');
    });

    it('should adjust based on confidence threshold', () => {
      const profile = createLearningProfile({
        confidenceThreshold: 80,
        feedbackCount: 10,
      });

      // Below threshold
      const belowResult = calculatePriorityAdjustment(profile, 'strategic', 60);
      expect(belowResult.multiplier).toBeLessThan(1.0);

      // Above threshold
      const aboveResult = calculatePriorityAdjustment(profile, 'strategic', 95);
      expect(aboveResult.multiplier).toBeGreaterThan(1.0);
    });

    it('should adjust based on engagement rate', () => {
      const lowEngagement = createLearningProfile({
        engagementRate: 0.2,
        feedbackCount: 10,
      });

      const highEngagement = createLearningProfile({
        engagementRate: 0.8,
        feedbackCount: 10,
      });

      const lowResult = calculatePriorityAdjustment(lowEngagement, 'strategic', 70);
      const highResult = calculatePriorityAdjustment(highEngagement, 'strategic', 70);

      expect(lowResult.multiplier).toBeLessThan(highResult.multiplier);
    });

    it('should clamp multiplier to 0.5-1.5 range', () => {
      // Create extreme profile to test clamping
      const extremeProfile = createLearningProfile({
        typePreferences: {
          strategic: 1.0,
          tactical: 0,
          reflective: 0,
          questioning: 0,
        },
        engagementRate: 1.0,
        confidenceThreshold: 50,
        feedbackCount: 100,
      });

      const result = calculatePriorityAdjustment(extremeProfile, 'strategic', 100);

      expect(result.multiplier).toBeLessThanOrEqual(1.5);
      expect(result.multiplier).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('filterInsightsByLearning', () => {
    it('should add adjustedPriority to insights', async () => {
      vi.mocked(env.CACHE.get).mockResolvedValueOnce(null); // No profile

      const insights = [
        { type: 'strategic' as InsightType, confidence: 80, id: '1' },
        { type: 'tactical' as InsightType, confidence: 60, id: '2' },
      ];

      const result = await filterInsightsByLearning(env, 'user-1', insights);

      expect(result[0]).toHaveProperty('adjustedPriority');
      expect(result[1]).toHaveProperty('adjustedPriority');
    });

    it('should sort insights by adjustedPriority descending', async () => {
      const profile = createLearningProfile({
        typePreferences: {
          strategic: 0.5, // Preferred
          tactical: -0.5, // Disliked
          reflective: 0,
          questioning: 0,
        },
        feedbackCount: 10,
      });
      vi.mocked(env.CACHE.get).mockResolvedValueOnce(profile);

      const insights = [
        { type: 'tactical' as InsightType, confidence: 90, id: '1' }, // Disliked but high confidence
        { type: 'strategic' as InsightType, confidence: 70, id: '2' }, // Preferred but lower confidence
      ];

      const result = await filterInsightsByLearning(env, 'user-1', insights);

      // Strategic should rank higher due to preference boost
      expect(result[0].type).toBe('strategic');
    });
  });

  describe('getFeedbackAnalytics', () => {
    it('should return null when no profile exists', async () => {
      vi.mocked(env.CACHE.get).mockResolvedValueOnce(null);

      const result = await getFeedbackAnalytics(env, 'user-1');

      expect(result).toBeNull();
    });

    it('should calculate correct rates', async () => {
      const profile = createLearningProfile({
        recentActions: [
          { action: 'accepted', count: 6 },
          { action: 'dismissed', count: 3 },
          { action: 'snoozed', count: 1 },
        ],
      });
      vi.mocked(env.CACHE.get).mockResolvedValueOnce(profile);

      const result = await getFeedbackAnalytics(env, 'user-1');

      expect(result).not.toBeNull();
      expect(result!.acceptRate).toBe(0.6); // 6/10
      expect(result!.dismissRate).toBe(0.3); // 3/10
      expect(result!.snoozeRate).toBe(0.1); // 1/10
    });

    it('should identify preferred and disliked types', async () => {
      const profile = createLearningProfile({
        typePreferences: {
          strategic: 0.5, // Preferred
          tactical: 0.3, // Preferred
          reflective: -0.5, // Disliked
          questioning: 0, // Neutral
        },
      });
      vi.mocked(env.CACHE.get).mockResolvedValueOnce(profile);

      const result = await getFeedbackAnalytics(env, 'user-1');

      expect(result).not.toBeNull();
      expect(result!.preferredTypes).toContain('strategic');
      expect(result!.preferredTypes).toContain('tactical');
      expect(result!.dislikedTypes).toContain('reflective');
      expect(result!.dislikedTypes).not.toContain('questioning');
    });
  });
});
