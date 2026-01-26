/**
 * Tests for Lifelog Processor Service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processLifelog,
  Classification,
  Sentiment,
  RawLifelogInput,
  ProcessedLifelog,
} from './lifelog-processor';

// Mock log-sanitizer
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('Lifelog Processor', () => {
  // Mock AI binding
  const createMockAI = (response: string | Error): Ai => {
    const mockRun = vi.fn().mockImplementation(async () => {
      if (response instanceof Error) {
        throw response;
      }
      return { response };
    });

    return {
      run: mockRun as any,
    } as Ai;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('processLifelog - Success Cases', () => {
    it('should successfully process a lifelog with markdown content', async () => {
      const aiResponse = JSON.stringify({
        classification: 'insight',
        summary: 'AIの倫理について議論しました。責任あるAI開発が重要です。',
        keyInsights: ['AI倫理の重要性', '透明性の確保'],
        actionItems: ['倫理ガイドライン作成', 'チームレビュー実施'],
        topics: ['AI倫理', '透明性', 'ガバナンス'],
        sentiment: 'positive',
        confidenceScore: 0.85,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-001',
        title: 'AI Ethics Discussion',
        markdown: '## AI倫理について\n\n責任あるAI開発が重要です。透明性を確保し、ガバナンスを強化する必要があります。',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T11:00:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('insight');
      expect(result.summary).toBe('AIの倫理について議論しました。責任あるAI開発が重要です。');
      expect(result.keyInsights).toEqual(['AI倫理の重要性', '透明性の確保']);
      expect(result.actionItems).toEqual(['倫理ガイドライン作成', 'チームレビュー実施']);
      expect(result.topics).toEqual(['AI倫理', '透明性', 'ガバナンス']);
      expect(result.sentiment).toBe('positive');
      expect(result.confidenceScore).toBe(0.85);
      expect(result.speakers).toEqual([]);
    });

    it('should successfully process a lifelog with content blocks', async () => {
      const aiResponse = JSON.stringify({
        classification: 'meeting',
        summary: 'プロジェクトの進捗確認を行いました。スケジュール通りです。',
        keyInsights: ['スケジュール順調'],
        actionItems: ['次週レビュー'],
        topics: ['プロジェクト管理', '進捗確認'],
        sentiment: 'positive',
        confidenceScore: 0.9,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-002',
        title: 'Weekly Standup',
        contents: [
          {
            content: 'プロジェクトは順調に進んでいます',
            type: 'blockquote',
            speakerName: 'Alice',
            startTime: '2024-01-25T10:00:00Z',
            endTime: '2024-01-25T10:05:00Z',
          },
          {
            content: 'タスクを完了しました',
            type: 'blockquote',
            speakerName: 'Bob',
            startTime: '2024-01-25T10:05:00Z',
            endTime: '2024-01-25T10:10:00Z',
          },
          {
            content: 'いいですね！',
            type: 'blockquote',
            speakerName: 'Alice',
            startTime: '2024-01-25T10:10:00Z',
            endTime: '2024-01-25T10:12:00Z',
          },
        ],
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:15:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('meeting');
      expect(result.summary).toBe('プロジェクトの進捗確認を行いました。スケジュール通りです。');
      expect(result.speakers).toEqual(['Alice', 'Bob']);
    });

    it('should parse AI response with markdown code block wrapper', async () => {
      const aiResponseWithCodeBlock = `Sure! Here's the analysis:

\`\`\`json
{
  "classification": "todo",
  "summary": "買い物リストを作成しました。",
  "keyInsights": [],
  "actionItems": ["牛乳を買う", "パンを買う"],
  "topics": ["買い物"],
  "sentiment": "neutral",
  "confidenceScore": 0.75
}
\`\`\`

This is the result.`;

      const mockAI = createMockAI(aiResponseWithCodeBlock);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-003',
        title: 'Shopping List',
        markdown: '牛乳とパンを買う。その他にも卵や野菜も買う必要があります。',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:01:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('todo');
      expect(result.summary).toBe('買い物リストを作成しました。');
      expect(result.actionItems).toEqual(['牛乳を買う', 'パンを買う']);
    });

    it('should extract speakers correctly from content blocks', async () => {
      const aiResponse = JSON.stringify({
        classification: 'brainstorm',
        summary: 'ブレインストーミングセッション',
        keyInsights: ['新しいアイデア'],
        actionItems: [],
        topics: ['イノベーション'],
        sentiment: 'positive',
        confidenceScore: 0.8,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-004',
        contents: [
          {
            content: 'アイデア1',
            type: 'blockquote',
            speakerName: 'Alice',
          },
          {
            content: 'アイデア2',
            type: 'blockquote',
            speakerName: 'Bob',
          },
          {
            content: 'アイデア3',
            type: 'blockquote',
            speakerName: 'Charlie',
          },
          {
            content: 'アイデア4',
            type: 'blockquote',
            speakerName: 'Alice', // Duplicate, should be deduplicated
          },
          {
            content: '不明な発言',
            type: 'blockquote',
            speakerName: 'Unknown', // Should be excluded
          },
          {
            content: '発言者なし',
            type: 'blockquote',
            // No speakerName
          },
        ],
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T11:00:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.speakers).toEqual(['Alice', 'Bob', 'Charlie']);
      expect(result.speakers).not.toContain('Unknown');
    });
  });

  describe('processLifelog - Edge Cases', () => {
    it('should return "casual" for very short content (<20 chars)', async () => {
      const mockAI = createMockAI('{}'); // AI should not be called

      const lifelog: RawLifelogInput = {
        id: 'lifelog-005',
        title: 'Short',
        markdown: 'Hi',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:00:30Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('casual');
      expect(result.summary).toBeNull();
      expect(result.keyInsights).toEqual([]);
      expect(result.actionItems).toEqual([]);
      expect(result.topics).toEqual([]);
      expect(result.speakers).toEqual([]);
      expect(result.sentiment).toBeNull();
      expect(result.confidenceScore).toBeNull();
      expect(mockAI.run).not.toHaveBeenCalled();
    });

    it('should return "casual" for lifelog with no content', async () => {
      const mockAI = createMockAI('{}');

      const lifelog: RawLifelogInput = {
        id: 'lifelog-006',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:00:30Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('casual');
      expect(result.summary).toBeNull();
      expect(mockAI.run).not.toHaveBeenCalled();
    });

    it('should return "unprocessed" when AI fails', async () => {
      const mockAI = createMockAI(new Error('AI service unavailable'));

      const lifelog: RawLifelogInput = {
        id: 'lifelog-007',
        title: 'Important Meeting',
        markdown: '## Important discussion\n\nThis is a very important meeting that should be processed.',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T11:00:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('unprocessed');
      expect(result.summary).toBeNull();
      expect(result.keyInsights).toEqual([]);
      expect(result.actionItems).toEqual([]);
      expect(result.topics).toEqual([]);
      expect(result.speakers).toEqual([]);
      expect(result.sentiment).toBeNull();
      expect(result.confidenceScore).toBeNull();
    });

    it('should handle malformed AI JSON response gracefully', async () => {
      const malformedResponse = '{ invalid json }';

      const mockAI = createMockAI(malformedResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-008',
        title: 'Malformed AI Response Test',
        markdown: 'This will trigger a malformed AI response.',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('unprocessed');
      expect(result.summary).toBeNull();
    });

    it('should handle AI response missing required fields', async () => {
      const incompleteResponse = JSON.stringify({
        classification: 'insight',
        // Missing required fields: summary, sentiment, confidenceScore
      });

      const mockAI = createMockAI(incompleteResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-009',
        title: 'Incomplete AI Response Test',
        markdown: 'This will trigger an incomplete AI response.',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('unprocessed');
      expect(result.summary).toBeNull();
    });

    it('should handle AI response with invalid classification', async () => {
      const invalidClassification = JSON.stringify({
        classification: 'invalid_category', // Not in allowed enum
        summary: 'Some summary',
        keyInsights: [],
        actionItems: [],
        topics: [],
        sentiment: 'positive',
        confidenceScore: 0.8,
      });

      const mockAI = createMockAI(invalidClassification);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-010',
        title: 'Invalid Classification Test',
        markdown: 'This will trigger an invalid classification.',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('unprocessed');
    });

    it('should handle AI response with empty response field', async () => {
      const mockAI = {
        run: vi.fn().mockResolvedValue({ response: '' }),
      } as unknown as Ai;

      const lifelog: RawLifelogInput = {
        id: 'lifelog-011',
        title: 'Empty Response Test',
        markdown: 'This will trigger an empty AI response.',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('unprocessed');
    });

    it('should handle AI response without response field', async () => {
      const mockAI = {
        run: vi.fn().mockResolvedValue({}),
      } as unknown as Ai;

      const lifelog: RawLifelogInput = {
        id: 'lifelog-012',
        title: 'Missing Response Field Test',
        markdown: 'This will trigger a response without the response field.',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T10:30:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('unprocessed');
    });
  });

  describe('processLifelog - Various Classification Types', () => {
    it('should classify as "meeting"', async () => {
      const aiResponse = JSON.stringify({
        classification: 'meeting',
        summary: '週次ミーティングを実施しました。',
        keyInsights: ['進捗順調'],
        actionItems: [],
        topics: ['週次レビュー'],
        sentiment: 'neutral',
        confidenceScore: 0.88,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-013',
        title: 'Weekly Meeting',
        markdown: '## 週次ミーティング\n\n進捗を確認しました。',
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T11:00:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('meeting');
    });

    it('should classify as "reflection"', async () => {
      const aiResponse = JSON.stringify({
        classification: 'reflection',
        summary: '今日の振り返りを行いました。',
        keyInsights: ['学んだこと'],
        actionItems: ['明日改善する'],
        topics: ['振り返り'],
        sentiment: 'positive',
        confidenceScore: 0.82,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-014',
        title: 'Daily Reflection',
        markdown: '今日学んだことを振り返ります。良い点と改善点を確認しました。',
        startTime: '2024-01-25T18:00:00Z',
        endTime: '2024-01-25T18:15:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.classification).toBe('reflection');
    });
  });

  describe('processLifelog - Sentiment Analysis', () => {
    it('should detect positive sentiment', async () => {
      const aiResponse = JSON.stringify({
        classification: 'casual',
        summary: '楽しい会話でした。',
        keyInsights: [],
        actionItems: [],
        topics: ['雑談'],
        sentiment: 'positive',
        confidenceScore: 0.7,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-015',
        title: 'Fun Chat',
        markdown: 'とても楽しい話でした！面白いトピックがたくさんありました。',
        startTime: '2024-01-25T12:00:00Z',
        endTime: '2024-01-25T12:30:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.sentiment).toBe('positive');
    });

    it('should detect negative sentiment', async () => {
      const aiResponse = JSON.stringify({
        classification: 'reflection',
        summary: '問題について議論しました。',
        keyInsights: ['改善が必要'],
        actionItems: ['対策を立てる'],
        topics: ['問題解決'],
        sentiment: 'negative',
        confidenceScore: 0.65,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-016',
        title: 'Problem Discussion',
        markdown: '問題が発生しました。対策が必要です。早急に対応する必要があります。',
        startTime: '2024-01-25T14:00:00Z',
        endTime: '2024-01-25T14:30:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.sentiment).toBe('negative');
    });

    it('should detect mixed sentiment', async () => {
      const aiResponse = JSON.stringify({
        classification: 'meeting',
        summary: '良い点と悪い点を議論しました。',
        keyInsights: ['改善の余地あり'],
        actionItems: [],
        topics: ['評価'],
        sentiment: 'mixed',
        confidenceScore: 0.78,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-017',
        title: 'Review Meeting',
        markdown: '成功もありましたが、改善点もあります。次回に向けて準備しましょう。',
        startTime: '2024-01-25T15:00:00Z',
        endTime: '2024-01-25T16:00:00Z',
      };

      const result = await processLifelog(mockAI, lifelog);

      expect(result.sentiment).toBe('mixed');
    });
  });

  describe('processLifelog - Content Building', () => {
    it('should prioritize markdown over content blocks', async () => {
      const aiResponse = JSON.stringify({
        classification: 'meeting',
        summary: 'Markdown優先テスト',
        keyInsights: [],
        actionItems: [],
        topics: [],
        sentiment: 'neutral',
        confidenceScore: 0.8,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-018',
        title: 'Markdown Priority Test',
        markdown: '## Markdown Content\n\nこれが使われるべき',
        contents: [
          {
            content: 'これは使われない',
            type: 'blockquote',
            speakerName: 'Alice',
          },
        ],
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T11:00:00Z',
      };

      await processLifelog(mockAI, lifelog);

      // Verify that AI was called with markdown content
      expect(mockAI.run).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining('Markdown Content'),
            }),
          ]),
        }),
        expect.any(Object)
      );
    });

    it('should use content blocks when markdown is empty', async () => {
      const aiResponse = JSON.stringify({
        classification: 'meeting',
        summary: 'コンテンツブロックテスト',
        keyInsights: [],
        actionItems: [],
        topics: [],
        sentiment: 'neutral',
        confidenceScore: 0.8,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-019',
        title: 'Content Blocks Test',
        markdown: '',
        contents: [
          {
            content: 'これが使われる。コンテンツブロックのテストです。',
            type: 'blockquote',
            speakerName: 'Bob',
          },
        ],
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T11:00:00Z',
      };

      await processLifelog(mockAI, lifelog);

      // Verify that AI was called with content block text
      expect(mockAI.run).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining('Bob: これが使われる。コンテンツブロックのテストです。'),
            }),
          ]),
        }),
        expect.any(Object)
      );
    });

    it('should filter only blockquote type content blocks', async () => {
      const aiResponse = JSON.stringify({
        classification: 'meeting',
        summary: 'フィルタテスト',
        keyInsights: [],
        actionItems: [],
        topics: [],
        sentiment: 'neutral',
        confidenceScore: 0.8,
      });

      const mockAI = createMockAI(aiResponse);

      const lifelog: RawLifelogInput = {
        id: 'lifelog-020',
        title: 'Content Filter Test',
        contents: [
          {
            content: 'Heading',
            type: 'heading1',
          },
          {
            content: 'これが使われる',
            type: 'blockquote',
            speakerName: 'Alice',
          },
          {
            content: 'Paragraph',
            type: 'paragraph',
          },
          {
            content: 'これも使われる',
            type: 'blockquote',
            speakerName: 'Bob',
          },
        ],
        startTime: '2024-01-25T10:00:00Z',
        endTime: '2024-01-25T11:00:00Z',
      };

      await processLifelog(mockAI, lifelog);

      // Verify that only blockquote content was used
      expect(mockAI.run).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringMatching(/Alice: これが使われる\nBob: これも使われる/),
            }),
          ]),
        }),
        expect.any(Object)
      );
    });
  });
});
