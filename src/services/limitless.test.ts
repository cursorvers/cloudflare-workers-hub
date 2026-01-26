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
    mockFetch.mockReset();
  });

  describe('getRecentLifelogs', () => {
    it('should fetch recent lifelogs successfully', async () => {
      const mockLifelogs: Lifelog[] = [
        {
          id: 'lifelog-1',
          title: 'Test Meeting',
          markdown: '## Test\n\n- Speaker: Hello world',
          contents: [
            { content: 'Test', type: 'heading1' },
            { content: 'Hello world', type: 'blockquote', speakerName: 'Speaker' },
          ],
          startTime: '2024-01-25T10:00:00Z',
          endTime: '2024-01-25T10:30:00Z',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { lifelogs: mockLifelogs },
          meta: { lifelogs: { count: 1, nextCursor: 'next-cursor' } },
        }),
      });

      const result = await getRecentLifelogs('test-api-key', { limit: 10 });

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
          title: 'Second Page',
          markdown: '## Second page content',
          startTime: '2024-01-25T11:00:00Z',
          endTime: '2024-01-25T11:30:00Z',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { lifelogs: mockLifelogs },
          meta: { lifelogs: { count: 1 } },
        }),
      });

      const result = await getRecentLifelogs('test-api-key', {
        limit: 10,
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
          json: async () => ({
            data: { lifelogs: [] },
            meta: { lifelogs: { count: 0 } },
          }),
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
      // Invalid limit (too high for beta API: max 10)
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
        json: async () => ({
          data: { lifelogs: [] },
          meta: { lifelogs: { count: 0 } },
        }),
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
        title: 'Specific Lifelog',
        markdown: '## Specific lifelog content',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLifelog,
      });

      const result = await getLifelog('test-api-key', 'lifelog-123');

      expect(result.id).toBe('lifelog-123');
      expect(result.title).toBe('Specific Lifelog');
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
          title: 'Sync test meeting',
          markdown: '## Summary\n\n- Speaker: Hello',
          contents: [
            { content: 'Summary', type: 'heading1' },
            { content: 'Hello', type: 'blockquote', speakerName: 'Speaker' },
          ],
          startTime: '2024-01-25T10:00:00Z',
          endTime: '2024-01-25T10:30:00Z',
        },
        {
          id: 'lifelog-2',
          title: 'Second meeting',
          markdown: '## Notes\n\n- Person: world',
          startTime: '2024-01-25T11:00:00Z',
          endTime: '2024-01-25T11:30:00Z',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { lifelogs: mockLifelogs },
          meta: { lifelogs: { count: 2 } },
        }),
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
          // No markdown, no contents
        },
        {
          id: 'lifelog-valid',
          title: 'Valid lifelog',
          markdown: '## Valid content',
          startTime: '2024-01-25T11:00:00Z',
          endTime: '2024-01-25T11:30:00Z',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { lifelogs: mockLifelogs },
          meta: { lifelogs: { count: 2 } },
        }),
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
          data: {
            lifelogs: [
              {
                id: 'lifelog-page1',
                title: 'Page 1',
                markdown: '## First page',
                startTime: '2024-01-25T10:00:00Z',
                endTime: '2024-01-25T10:30:00Z',
              },
            ],
          },
          meta: { lifelogs: { count: 1, nextCursor: 'page-2-cursor' } },
        }),
      });

      // Second page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            lifelogs: [
              {
                id: 'lifelog-page2',
                title: 'Page 2',
                markdown: '## Second page',
                startTime: '2024-01-25T11:00:00Z',
                endTime: '2024-01-25T11:30:00Z',
              },
            ],
          },
          meta: { lifelogs: { count: 1 } },
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
        title: 'Audio test',
        markdown: '## Audio recording',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
      };

      // First call: getRecentLifelogs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { lifelogs: [mockLifelog] },
          meta: { lifelogs: { count: 1 } },
        }),
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
        title: 'Audio fail test',
        markdown: '## Audio download will fail',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
      };

      // First call: getRecentLifelogs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { lifelogs: [mockLifelog] },
          meta: { lifelogs: { count: 1 } },
        }),
      });

      // Second call: downloadAudio fails
      mockFetch.mockRejectedValueOnce(new Error('Audio download failed'));

      const result = await syncToKnowledge(mockEnv, 'test-api-key', {
        userId: 'user-123',
        includeAudio: true,
      });

      // Should still sync the markdown content
      expect(result.synced).toBe(1);
    });

    it('should collect errors for failed syncs', async () => {
      const { storeKnowledge } = await import('./knowledge');

      // Mock storeKnowledge to fail
      vi.mocked(storeKnowledge).mockRejectedValueOnce(new Error('Storage failed'));

      const mockLifelog: Lifelog = {
        id: 'lifelog-fail-storage',
        title: 'Storage fail test',
        markdown: '## This will fail',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { lifelogs: [mockLifelog] },
          meta: { lifelogs: { count: 1 } },
        }),
      });

      const result = await syncToKnowledge(mockEnv, 'test-api-key', {
        userId: 'user-123',
      });

      expect(result.synced).toBe(0);
      expect(result.errors).toHaveLength(1);
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
