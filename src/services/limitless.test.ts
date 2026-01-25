/**
 * Tests for Limitless.ai API Integration Service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getRecentLifelogs,
  getLifelog,
  downloadAudio,
  syncToKnowledge,
  Lifelog,
} from './limitless';
import { Env } from '../types';

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock knowledge service
vi.mock('./knowledge', () => ({
  storeKnowledge: vi.fn().mockResolvedValue('mock-knowledge-id'),
}));

describe('Limitless Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getRecentLifelogs', () => {
    it('should fetch recent lifelogs successfully', async () => {
      const mockLifelogs: Lifelog[] = [
        {
          id: 'lifelog-1',
          startTime: '2024-01-25T10:00:00Z',
          endTime: '2024-01-25T10:30:00Z',
          transcript: 'Test transcript',
          summary: 'Test summary',
          tags: ['work', 'meeting'],
          duration: 1800,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lifelogs: mockLifelogs, cursor: 'next-cursor' }),
      });

      const result = await getRecentLifelogs('test-api-key', { limit: 20 });

      expect(result.lifelogs).toHaveLength(1);
      expect(result.lifelogs[0].id).toBe('lifelog-1');
      expect(result.cursor).toBe('next-cursor');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/lifelogs?'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-API-Key': 'test-api-key',
          }),
        })
      );
    });

    it('should handle pagination with cursor', async () => {
      const mockLifelogs: Lifelog[] = [
        {
          id: 'lifelog-2',
          startTime: '2024-01-25T11:00:00Z',
          endTime: '2024-01-25T11:30:00Z',
          transcript: 'Second page transcript',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lifelogs: mockLifelogs }),
      });

      const result = await getRecentLifelogs('test-api-key', {
        limit: 20,
        cursor: 'existing-cursor',
      });

      expect(result.lifelogs).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('cursor=existing-cursor'),
        expect.any(Object)
      );
    });

    it('should handle API errors with retry', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ lifelogs: [] }),
        });

      const result = await getRecentLifelogs('test-api-key');

      expect(result.lifelogs).toHaveLength(0);
      expect(mockFetch).toHaveBeenCalledTimes(3); // 2 failures + 1 success
    });

    it('should throw error after max retries', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(getRecentLifelogs('test-api-key')).rejects.toThrow('Failed to fetch lifelogs');
      expect(mockFetch).toHaveBeenCalledTimes(3); // MAX_RETRIES
    });

    it('should validate input options', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lifelogs: [] }),
      });

      // Invalid limit (too high)
      await expect(
        getRecentLifelogs('test-api-key', { limit: 200 } as any)
      ).rejects.toThrow();

      // Invalid limit (too low)
      await expect(
        getRecentLifelogs('test-api-key', { limit: 0 } as any)
      ).rejects.toThrow();
    });

    it('should handle time range filters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lifelogs: [] }),
      });

      const startTime = '2024-01-25T00:00:00Z';
      const endTime = '2024-01-25T23:59:59Z';

      await getRecentLifelogs('test-api-key', { startTime, endTime });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('start_time='),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('end_time='),
        expect.any(Object)
      );
    });
  });

  describe('getLifelog', () => {
    it('should fetch a specific lifelog', async () => {
      const mockLifelog: Lifelog = {
        id: 'lifelog-123',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
        transcript: 'Specific lifelog transcript',
        summary: 'Specific lifelog summary',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLifelog,
      });

      const result = await getLifelog('test-api-key', 'lifelog-123');

      expect(result.id).toBe('lifelog-123');
      expect(result.transcript).toBe('Specific lifelog transcript');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/lifelogs/lifelog-123'),
        expect.any(Object)
      );
    });

    it('should throw error for empty lifelog ID', async () => {
      await expect(getLifelog('test-api-key', '')).rejects.toThrow('Lifelog ID is required');
    });

    it('should handle 404 errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Lifelog not found',
      });

      await expect(getLifelog('test-api-key', 'non-existent')).rejects.toThrow('HTTP 404');
    });
  });

  describe('downloadAudio', () => {
    it('should download audio successfully', async () => {
      const mockAudioBuffer = new ArrayBuffer(1024);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioBuffer,
      });

      const result = await downloadAudio('test-api-key', {
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
        format: 'ogg',
      });

      expect(result).toBe(mockAudioBuffer);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/audio?'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'test-api-key',
          }),
        })
      );
    });

    it('should validate duration (max 2 hours)', async () => {
      // 3 hours duration (exceeds limit)
      await expect(
        downloadAudio('test-api-key', {
          startTime: '2024-01-25T10:00:00Z',
          endTime: '2024-01-25T13:00:00Z', // 3 hours later
        })
      ).rejects.toThrow('exceeds maximum allowed');
    });

    it('should validate time range (endTime > startTime)', async () => {
      await expect(
        downloadAudio('test-api-key', {
          startTime: '2024-01-25T10:00:00Z',
          endTime: '2024-01-25T09:00:00Z', // before startTime
        })
      ).rejects.toThrow('endTime must be after startTime');
    });

    it('should use default format (ogg)', async () => {
      const mockAudioBuffer = new ArrayBuffer(512);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioBuffer,
      });

      await downloadAudio('test-api-key', {
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:15:00Z',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('format=ogg'),
        expect.any(Object)
      );
    });

    it('should support mp3 format', async () => {
      const mockAudioBuffer = new ArrayBuffer(512);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioBuffer,
      });

      await downloadAudio('test-api-key', {
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:15:00Z',
        format: 'mp3',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('format=mp3'),
        expect.any(Object)
      );
    });
  });

  describe('syncToKnowledge', () => {
    const mockEnv: Env = {
      AI: {} as any,
      DB: {} as any,
      OBSIDIAN_VAULT: {} as any,
      KNOWLEDGE_INDEX: {} as any,
      AUDIO_STAGING: {
        put: vi.fn().mockResolvedValue(undefined),
      } as any,
      ENVIRONMENT: 'test',
    };

    it('should sync lifelogs to knowledge service', async () => {
      const mockLifelogs: Lifelog[] = [
        {
          id: 'lifelog-1',
          startTime: '2024-01-25T10:00:00Z',
          endTime: '2024-01-25T10:30:00Z',
          transcript: 'Sync test transcript',
          summary: 'Sync test summary',
          tags: ['test'],
        },
        {
          id: 'lifelog-2',
          startTime: '2024-01-25T11:00:00Z',
          endTime: '2024-01-25T11:30:00Z',
          transcript: 'Second sync test',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lifelogs: mockLifelogs }),
      });

      const result = await syncToKnowledge(mockEnv, 'test-api-key', {
        userId: 'user-123',
        maxAgeHours: 24,
      });

      expect(result.synced).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should skip lifelogs without content', async () => {
      const mockLifelogs: Lifelog[] = [
        {
          id: 'lifelog-empty',
          startTime: '2024-01-25T10:00:00Z',
          endTime: '2024-01-25T10:30:00Z',
          // No transcript or summary
        },
        {
          id: 'lifelog-valid',
          startTime: '2024-01-25T11:00:00Z',
          endTime: '2024-01-25T11:30:00Z',
          transcript: 'Valid transcript',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lifelogs: mockLifelogs }),
      });

      const result = await syncToKnowledge(mockEnv, 'test-api-key', {
        userId: 'user-123',
      });

      expect(result.synced).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('should handle pagination during sync', async () => {
      // First page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          lifelogs: [
            {
              id: 'lifelog-page1',
              startTime: '2024-01-25T10:00:00Z',
              endTime: '2024-01-25T10:30:00Z',
              transcript: 'First page',
            },
          ],
          cursor: 'page-2-cursor',
        }),
      });

      // Second page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          lifelogs: [
            {
              id: 'lifelog-page2',
              startTime: '2024-01-25T11:00:00Z',
              endTime: '2024-01-25T11:30:00Z',
              transcript: 'Second page',
            },
          ],
        }),
      });

      const result = await syncToKnowledge(mockEnv, 'test-api-key', {
        userId: 'user-123',
      });

      expect(result.synced).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2); // Two pages
    });

    it('should download audio if includeAudio is true', async () => {
      const mockLifelog: Lifelog = {
        id: 'lifelog-audio',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
        transcript: 'Audio test',
        audioUrl: 'https://example.com/audio.ogg',
        duration: 1800,
      };

      // First call: getRecentLifelogs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lifelogs: [mockLifelog] }),
      });

      // Second call: downloadAudio
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024),
      });

      const result = await syncToKnowledge(mockEnv, 'test-api-key', {
        userId: 'user-123',
        includeAudio: true,
      });

      expect(result.synced).toBe(1);
      expect(mockEnv.AUDIO_STAGING?.put).toHaveBeenCalled();
    });

    it('should continue sync even if audio download fails', async () => {
      const mockLifelog: Lifelog = {
        id: 'lifelog-audio-fail',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
        transcript: 'Audio download will fail',
        audioUrl: 'https://example.com/audio.ogg',
      };

      // First call: getRecentLifelogs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lifelogs: [mockLifelog] }),
      });

      // Second call: downloadAudio fails
      mockFetch.mockRejectedValueOnce(new Error('Audio download failed'));

      const result = await syncToKnowledge(mockEnv, 'test-api-key', {
        userId: 'user-123',
        includeAudio: true,
      });

      // Should still sync the transcript/summary
      expect(result.synced).toBe(1);
    });

    it('should collect errors for failed syncs', async () => {
      const { storeKnowledge } = await import('./knowledge');

      // Mock storeKnowledge to fail
      vi.mocked(storeKnowledge).mockRejectedValueOnce(new Error('Storage failed'));

      const mockLifelog: Lifelog = {
        id: 'lifelog-fail-storage',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
        transcript: 'This will fail',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lifelogs: [mockLifelog] }),
      });

      const result = await syncToKnowledge(mockEnv, 'test-api-key', {
        userId: 'user-123',
      });

      expect(result.synced).toBe(0);
      expect(result.errors).toHaveLength(1);
      // Check that error contains storage failure message (not specific ID due to test contamination)
      expect(result.errors[0]).toContain('Storage failed');
    });

    it('should validate sync options', async () => {
      await expect(
        syncToKnowledge(mockEnv, 'test-api-key', {
          userId: '', // Invalid: empty userId
        })
      ).rejects.toThrow();

      await expect(
        syncToKnowledge(mockEnv, 'test-api-key', {
          userId: 'user-123',
          maxAgeHours: 200, // Invalid: exceeds 168 hours
        } as any)
      ).rejects.toThrow();
    });
  });
});
