/**
 * Tests for Whisper Transcription Service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transcribeAudio } from './transcription';
import type { Env } from '../types';

describe('Transcription Service', () => {
  let mockEnv: Env;

  beforeEach(() => {
    // Mock environment with AI binding
    mockEnv = {
      AI: {
        run: vi.fn(),
      } as unknown as Ai,
      ENVIRONMENT: 'test',
    };
  });

  describe('transcribeAudio', () => {
    it('should transcribe audio from ArrayBuffer', async () => {
      // Mock AI response
      const mockResponse = {
        text: 'Hello, this is a test transcription.',
        word_count: 6,
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      // Create sample audio buffer (small test data)
      const audioBuffer = new ArrayBuffer(1024);

      const result = await transcribeAudio(mockEnv, audioBuffer);

      expect(result).toMatchObject({
        text: 'Hello, this is a test transcription.',
        language: 'unknown',
        confidence: expect.any(Number),
      });

      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);

      // Verify AI was called with correct model
      expect(mockEnv.AI.run).toHaveBeenCalledWith(
        '@cf/openai/whisper-large-v3-turbo',
        expect.objectContaining({
          audio: expect.any(Array),
        })
      );
    });

    it('should transcribe audio from Base64 string', async () => {
      const mockResponse = {
        text: 'Transcribed from Base64',
        word_count: 3,
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      // Create base64 encoded data (simple test string)
      const testData = 'test audio data';
      const base64 = btoa(testData);

      const result = await transcribeAudio(mockEnv, base64);

      expect(result.text).toBe('Transcribed from Base64');
      expect(mockEnv.AI.run).toHaveBeenCalled();
    });

    it('should handle data URL prefix in Base64', async () => {
      const mockResponse = {
        text: 'Transcribed from data URL',
        word_count: 4,
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      const testData = 'test audio data';
      const base64WithPrefix = `data:audio/mp3;base64,${btoa(testData)}`;

      const result = await transcribeAudio(mockEnv, base64WithPrefix);

      expect(result.text).toBe('Transcribed from data URL');
    });

    it('should include language hint when provided', async () => {
      const mockResponse = {
        text: 'こんにちは、テストです。',
        word_count: 3,
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      const audioBuffer = new ArrayBuffer(1024);

      const result = await transcribeAudio(mockEnv, audioBuffer, {
        language: 'ja',
      });

      expect(result.language).toBe('ja');
      expect(mockEnv.AI.run).toHaveBeenCalledWith(
        '@cf/openai/whisper-large-v3-turbo',
        expect.objectContaining({
          source_lang: 'ja',
        })
      );
    });

    it('should generate WebVTT when word timestamps are available', async () => {
      const mockResponse = {
        text: 'Hello world',
        word_count: 2,
        words: [
          { word: 'Hello', start: 0.0, end: 0.5 },
          { word: 'world', start: 0.6, end: 1.0 },
        ],
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      const audioBuffer = new ArrayBuffer(1024);
      const result = await transcribeAudio(mockEnv, audioBuffer);

      expect(result.vtt).toBeDefined();
      expect(result.vtt).toContain('WEBVTT');
      expect(result.vtt).toContain('Hello');
      expect(result.vtt).toContain('world');
      expect(result.vtt).toContain('00:00:00.000 --> 00:00:00.500');
    });

    it('should retry on failure', async () => {
      const mockResponse = {
        text: 'Success after retry',
        word_count: 3,
      };

      // Fail first two times, succeed on third
      vi.mocked(mockEnv.AI.run)
        .mockRejectedValueOnce(new Error('Temporary failure 1'))
        .mockRejectedValueOnce(new Error('Temporary failure 2'))
        .mockResolvedValueOnce(mockResponse);

      const audioBuffer = new ArrayBuffer(1024);

      const result = await transcribeAudio(mockEnv, audioBuffer);

      expect(result.text).toBe('Success after retry');
      expect(mockEnv.AI.run).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries', async () => {
      vi.mocked(mockEnv.AI.run).mockRejectedValue(new Error('Persistent failure'));

      const audioBuffer = new ArrayBuffer(1024);

      await expect(transcribeAudio(mockEnv, audioBuffer)).rejects.toThrow(
        /Transcription failed after 3 attempts/
      );

      expect(mockEnv.AI.run).toHaveBeenCalledTimes(3);
    });

    it('should handle empty transcription result', async () => {
      const mockResponse = {
        text: '',
        word_count: 0,
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      const audioBuffer = new ArrayBuffer(1024);
      const result = await transcribeAudio(mockEnv, audioBuffer);

      expect(result.text).toBe('');
      expect(result.confidence).toBe(0.0);
    });

    it('should calculate confidence based on word count', async () => {
      const mockResponse = {
        text: 'A text with exactly twenty five words to test the confidence calculation based on word count metric value.',
        word_count: 25,
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      const audioBuffer = new ArrayBuffer(1024);
      const result = await transcribeAudio(mockEnv, audioBuffer);

      // 25 words / 50 = 0.5 confidence
      expect(result.confidence).toBe(0.5);
    });

    it('should cap confidence at 1.0', async () => {
      const mockResponse = {
        text: 'A very long transcription with many words',
        word_count: 100, // More than 50 words
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      const audioBuffer = new ArrayBuffer(1024);
      const result = await transcribeAudio(mockEnv, audioBuffer);

      expect(result.confidence).toBe(1.0);
    });

    it('should estimate duration from file size', async () => {
      const mockResponse = {
        text: 'Test',
        word_count: 1,
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      // 2MB file should be ~120 seconds
      const audioBuffer = new ArrayBuffer(2 * 1024 * 1024);
      const result = await transcribeAudio(mockEnv, audioBuffer);

      expect(result.duration_seconds).toBe(120);
    });

    it('should throw error for invalid Base64', async () => {
      const invalidBase64 = 'not-valid-base64!!!';

      await expect(transcribeAudio(mockEnv, invalidBase64)).rejects.toThrow(
        /Invalid Base64 audio data/
      );
    });
  });

  describe('Large File Handling', () => {
    it('should handle chunking for large files', async () => {
      const mockResponse = {
        text: 'Chunk',
        word_count: 1,
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      // Create 30MB buffer (exceeds 25MB limit)
      const largeBuffer = new ArrayBuffer(30 * 1024 * 1024);

      const result = await transcribeAudio(mockEnv, largeBuffer);

      // Should merge results from multiple chunks
      expect(result.text).toContain('Chunk');
      // Should be called multiple times (chunked)
      expect(vi.mocked(mockEnv.AI.run).mock.calls.length).toBeGreaterThan(1);
    });

    it('should merge VTT from multiple chunks', async () => {
      const mockResponse = {
        text: 'Part',
        word_count: 1,
        words: [{ word: 'Part', start: 0.0, end: 0.5 }],
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      // Create large buffer
      const largeBuffer = new ArrayBuffer(30 * 1024 * 1024);

      const result = await transcribeAudio(mockEnv, largeBuffer);

      expect(result.vtt).toBeDefined();
      expect(result.vtt).toContain('WEBVTT');
    });
  });

  describe('WebVTT Generation', () => {
    it('should format timestamps correctly', async () => {
      const mockResponse = {
        text: 'Test timing',
        word_count: 2,
        words: [
          { word: 'Test', start: 0.0, end: 1.234 },
          { word: 'timing', start: 65.5, end: 66.789 }, // Test minute rollover
        ],
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      const audioBuffer = new ArrayBuffer(1024);
      const result = await transcribeAudio(mockEnv, audioBuffer);

      expect(result.vtt).toContain('00:00:00.000 --> 00:00:01.234');
      expect(result.vtt).toContain('00:01:05.500 --> 00:01:06.789');
    });

    it('should format hours correctly', async () => {
      const mockResponse = {
        text: 'Long audio',
        word_count: 2,
        words: [{ word: 'Long', start: 3661.5, end: 3662.0 }], // 1 hour, 1 minute, 1.5 seconds
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      const audioBuffer = new ArrayBuffer(1024);
      const result = await transcribeAudio(mockEnv, audioBuffer);

      expect(result.vtt).toContain('01:01:01.500 --> 01:01:02.000');
    });
  });

  describe('Options Validation', () => {
    it('should validate language option', async () => {
      const mockResponse = {
        text: 'Valid',
        word_count: 1,
      };

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockResponse);

      const audioBuffer = new ArrayBuffer(1024);

      // Valid language code
      await expect(
        transcribeAudio(mockEnv, audioBuffer, { language: 'en' })
      ).resolves.toBeDefined();
    });

    it('should reject invalid options', async () => {
      const audioBuffer = new ArrayBuffer(1024);

      // Invalid option type
      await expect(
        // @ts-expect-error Testing invalid input
        transcribeAudio(mockEnv, audioBuffer, { language: 123 })
      ).rejects.toThrow();
    });
  });
});
