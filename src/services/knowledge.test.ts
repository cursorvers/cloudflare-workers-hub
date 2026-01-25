/**
 * Tests for Knowledge Storage Service
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storeKnowledge, searchKnowledge, type KnowledgeItem } from './knowledge';
import type { Env } from '../types';

// Mock safeLog to avoid console output in tests
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Knowledge Service', () => {
  let mockEnv: Env;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Create mock environment with all bindings
    mockEnv = {
      AI: {
        run: vi.fn(),
      } as unknown as Ai,
      DB: {
        prepare: vi.fn(),
      } as unknown as D1Database,
      OBSIDIAN_VAULT: {
        put: vi.fn(),
        get: vi.fn(),
      } as unknown as R2Bucket,
      KNOWLEDGE_INDEX: {
        upsert: vi.fn(),
        query: vi.fn(),
      } as unknown as VectorizeIndex,
      ENVIRONMENT: 'test',
    };
  });

  describe('storeKnowledge', () => {
    it('should validate and store a complete knowledge item', async () => {
      const item: KnowledgeItem = {
        userId: 'user123',
        source: 'telegram',
        type: 'voice_note',
        title: 'Meeting Notes',
        content: 'Discussed project timeline and milestones.',
        tags: ['meeting', 'project'],
        createdAt: '2024-01-25T10:00:00Z',
      };

      // Mock successful AI embedding generation
      const mockEmbedding = new Array(768).fill(0.1);
      (mockEnv.AI.run as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [mockEmbedding],
      });

      // Mock successful R2 put
      (mockEnv.OBSIDIAN_VAULT!.put as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined
      );

      // Mock successful Vectorize upsert
      (mockEnv.KNOWLEDGE_INDEX!.upsert as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined
      );

      // Mock successful D1 insert
      const mockPrepare = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      (mockEnv.DB!.prepare as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPrepare);

      const id = await storeKnowledge(mockEnv, item);

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');

      // Verify R2 was called
      expect(mockEnv.OBSIDIAN_VAULT!.put).toHaveBeenCalledWith(
        expect.stringContaining('knowledge/user123/'),
        expect.stringContaining('# Meeting Notes'),
        expect.objectContaining({
          httpMetadata: { contentType: 'text/markdown' },
          customMetadata: expect.objectContaining({
            userId: 'user123',
            source: 'telegram',
            type: 'voice_note',
            title: 'Meeting Notes',
          }),
        })
      );

      // Verify AI was called for embedding
      expect(mockEnv.AI.run).toHaveBeenCalledWith(
        '@cf/baai/bge-base-en-v1.5',
        expect.objectContaining({
          text: expect.stringContaining('Meeting Notes'),
        })
      );

      // Verify Vectorize was called
      expect(mockEnv.KNOWLEDGE_INDEX!.upsert).toHaveBeenCalledWith([
        expect.objectContaining({
          id: expect.stringContaining('knowledge_'),
          values: mockEmbedding,
          metadata: expect.objectContaining({
            userId: 'user123',
            source: 'telegram',
            type: 'voice_note',
            title: 'Meeting Notes',
          }),
        }),
      ]);

      // Verify D1 was called
      expect(mockEnv.DB!.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO knowledge_items')
      );
    });

    it('should reject invalid input - missing userId', async () => {
      const invalidItem = {
        source: 'telegram',
        type: 'voice_note',
        title: 'Test',
        content: 'Test content',
      } as KnowledgeItem;

      await expect(storeKnowledge(mockEnv, invalidItem)).rejects.toThrow();
    });

    it('should reject invalid input - invalid source', async () => {
      const invalidItem = {
        userId: 'user123',
        source: 'invalid_source',
        type: 'voice_note',
        title: 'Test',
        content: 'Test content',
      } as unknown as KnowledgeItem;

      await expect(storeKnowledge(mockEnv, invalidItem)).rejects.toThrow();
    });

    it('should reject invalid input - empty title', async () => {
      const invalidItem = {
        userId: 'user123',
        source: 'telegram',
        type: 'voice_note',
        title: '',
        content: 'Test content',
      } as KnowledgeItem;

      await expect(storeKnowledge(mockEnv, invalidItem)).rejects.toThrow();
    });

    it('should handle R2 bucket not configured', async () => {
      const item: KnowledgeItem = {
        userId: 'user123',
        source: 'telegram',
        type: 'voice_note',
        title: 'Test',
        content: 'Test content',
      };

      // Remove R2 binding
      mockEnv.OBSIDIAN_VAULT = undefined;

      await expect(storeKnowledge(mockEnv, item)).rejects.toThrow(
        'R2 bucket OBSIDIAN_VAULT not configured'
      );
    });

    it('should gracefully skip Vectorize if not configured', async () => {
      const item: KnowledgeItem = {
        userId: 'user123',
        source: 'manual',
        type: 'document',
        title: 'Test Document',
        content: 'This is a test document.',
      };

      // Remove Vectorize binding
      mockEnv.KNOWLEDGE_INDEX = undefined;

      // Mock R2 put
      (mockEnv.OBSIDIAN_VAULT!.put as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined
      );

      // Mock D1 insert
      const mockPrepare = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      (mockEnv.DB!.prepare as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPrepare);

      const id = await storeKnowledge(mockEnv, item);

      expect(id).toBeDefined();

      // Verify R2 was called
      expect(mockEnv.OBSIDIAN_VAULT!.put).toHaveBeenCalled();

      // Verify AI embedding was NOT called (no Vectorize)
      expect(mockEnv.AI.run).not.toHaveBeenCalled();
    });

    it('should gracefully skip D1 metadata if not configured', async () => {
      const item: KnowledgeItem = {
        userId: 'user123',
        source: 'discord',
        type: 'conversation',
        title: 'Chat Log',
        content: 'User A: Hello\nUser B: Hi there!',
      };

      // Remove D1 binding
      mockEnv.DB = undefined;

      // Mock R2 put
      (mockEnv.OBSIDIAN_VAULT!.put as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined
      );

      // Mock AI embedding
      const mockEmbedding = new Array(768).fill(0.2);
      (mockEnv.AI.run as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [mockEmbedding],
      });

      // Mock Vectorize upsert
      (mockEnv.KNOWLEDGE_INDEX!.upsert as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined
      );

      const id = await storeKnowledge(mockEnv, item);

      expect(id).toBeDefined();

      // Verify R2 and Vectorize were called, but D1 was skipped
      expect(mockEnv.OBSIDIAN_VAULT!.put).toHaveBeenCalled();
      expect(mockEnv.KNOWLEDGE_INDEX!.upsert).toHaveBeenCalled();
    });

    it('should include audio path in stored metadata', async () => {
      const item: KnowledgeItem = {
        userId: 'user123',
        source: 'whatsapp',
        type: 'voice_note',
        title: 'Voice Message',
        content: 'Transcribed voice message content.',
        audioPath: 'audio/user123/message.ogg',
      };

      // Mock R2 put
      (mockEnv.OBSIDIAN_VAULT!.put as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined
      );

      // Mock AI embedding
      (mockEnv.AI.run as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [new Array(768).fill(0.3)],
      });

      // Mock Vectorize upsert
      (mockEnv.KNOWLEDGE_INDEX!.upsert as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined
      );

      // Mock D1 insert
      const mockPrepare = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      (mockEnv.DB!.prepare as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPrepare);

      await storeKnowledge(mockEnv, item);

      // Verify audioPath was included in D1 bind
      expect(mockPrepare.bind).toHaveBeenCalledWith(
        expect.any(String), // id
        'user123', // user_id
        'whatsapp', // source
        'voice_note', // type
        'Voice Message', // title
        expect.any(String), // content_preview
        expect.stringContaining('knowledge/user123/'), // r2_path
        'audio/user123/message.ogg', // audio_path
        expect.any(String), // vectorize_id
        'ja', // language
        expect.any(Number), // word_count
        null, // tags
        expect.any(String), // created_at
        expect.any(String) // updated_at
      );
    });
  });

  describe('searchKnowledge', () => {
    it('should perform semantic search when Vectorize is available', async () => {
      const query = 'project timeline';
      const userId = 'user123';

      // Mock AI embedding generation
      const mockQueryEmbedding = new Array(768).fill(0.5);
      (mockEnv.AI.run as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [mockQueryEmbedding],
      });

      // Mock Vectorize query results
      const mockVectorizeResults = {
        matches: [
          {
            id: 'knowledge_abc123',
            score: 0.95,
            metadata: {
              userId: 'user123',
              source: 'telegram',
              type: 'voice_note',
              title: 'Meeting Notes',
              createdAt: '2024-01-25T10:00:00Z',
            },
          },
        ],
      };
      (mockEnv.KNOWLEDGE_INDEX!.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockVectorizeResults
      );

      // Mock D1 query for R2 path
      const mockD1Result = { r2_path: 'knowledge/user123/abc123.md' };
      const mockPrepare = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(mockD1Result),
      };
      (mockEnv.DB!.prepare as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPrepare);

      // Mock R2 get
      const mockR2Object = {
        text: vi
          .fn()
          .mockResolvedValue(
            '---\ntitle: Meeting Notes\n---\n\n# Meeting Notes\n\nDiscussed project timeline.'
          ),
      };
      (mockEnv.OBSIDIAN_VAULT!.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockR2Object
      );

      const results = await searchKnowledge(mockEnv, query, userId, 10);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'abc123',
        userId: 'user123',
        source: 'telegram',
        type: 'voice_note',
        title: 'Meeting Notes',
        content: 'Discussed project timeline.',
      });

      // Verify Vectorize query was called
      expect(mockEnv.KNOWLEDGE_INDEX!.query).toHaveBeenCalledWith(mockQueryEmbedding, {
        topK: 10,
        filter: { userId: 'user123' },
      });
    });

    it('should fallback to full-text search when Vectorize is unavailable', async () => {
      const query = 'meeting notes';
      const userId = 'user123';

      // Remove Vectorize binding
      mockEnv.KNOWLEDGE_INDEX = undefined;

      // Mock D1 FTS query
      const mockD1Results = {
        results: [
          {
            id: 'item123',
            user_id: 'user123',
            source: 'telegram',
            type: 'voice_note',
            title: 'Meeting Notes',
            content_preview: 'Discussed project timeline and milestones.',
            r2_path: 'knowledge/user123/item123.md',
            audio_path: null,
            vectorize_id: null,
            language: 'ja',
            duration_seconds: null,
            word_count: 6,
            tags: 'meeting,project',
            created_at: '2024-01-25T10:00:00Z',
            updated_at: '2024-01-25T10:00:00Z',
            synced_at: null,
          },
        ],
      };
      const mockPrepare = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue(mockD1Results),
      };
      (mockEnv.DB!.prepare as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPrepare);

      // Mock R2 get for full content
      const mockR2Object = {
        text: vi
          .fn()
          .mockResolvedValue(
            '---\ntitle: Meeting Notes\n---\n\n# Meeting Notes\n\nFull meeting content here.'
          ),
      };
      (mockEnv.OBSIDIAN_VAULT!.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockR2Object
      );

      const results = await searchKnowledge(mockEnv, query, userId, 10);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'item123',
        userId: 'user123',
        source: 'telegram',
        type: 'voice_note',
        title: 'Meeting Notes',
        content: 'Full meeting content here.',
        tags: ['meeting', 'project'],
      });

      // Verify D1 FTS was called
      expect(mockEnv.DB!.prepare).toHaveBeenCalledWith(
        expect.stringContaining('knowledge_fts MATCH')
      );
    });

    it('should return empty array when no search capabilities available', async () => {
      const query = 'test query';
      const userId = 'user123';

      // Remove both Vectorize and D1
      mockEnv.KNOWLEDGE_INDEX = undefined;
      mockEnv.DB = undefined;

      const results = await searchKnowledge(mockEnv, query, userId, 10);

      expect(results).toEqual([]);
    });

    it('should handle errors gracefully and return empty array', async () => {
      const query = 'project timeline';
      const userId = 'user123';

      // Mock AI embedding to throw error
      (mockEnv.AI.run as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('AI service unavailable')
      );

      // Mock D1 FTS as fallback
      const mockPrepare = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      (mockEnv.DB!.prepare as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPrepare);

      const results = await searchKnowledge(mockEnv, query, userId, 10);

      expect(results).toEqual([]);
    });

    it('should require query and userId parameters', async () => {
      await expect(searchKnowledge(mockEnv, '', 'user123', 10)).rejects.toThrow(
        'Query and userId are required'
      );

      await expect(searchKnowledge(mockEnv, 'test', '', 10)).rejects.toThrow(
        'Query and userId are required'
      );
    });

    it('should respect limit parameter', async () => {
      const query = 'test';
      const userId = 'user123';
      const limit = 5;

      // Mock Vectorize query
      const mockQueryEmbedding = new Array(768).fill(0.1);
      (mockEnv.AI.run as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [mockQueryEmbedding],
      });

      const mockVectorizeResults = { matches: [] };
      (mockEnv.KNOWLEDGE_INDEX!.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockVectorizeResults
      );

      await searchKnowledge(mockEnv, query, userId, limit);

      expect(mockEnv.KNOWLEDGE_INDEX!.query).toHaveBeenCalledWith(mockQueryEmbedding, {
        topK: limit,
        filter: { userId },
      });
    });
  });
});
