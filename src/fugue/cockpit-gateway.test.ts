/**
 * Tests for CockpitGateway
 *
 * Testing strategy:
 * 1. Message transformation (WebSocket → OrchestratorRequest)
 * 2. Delegation rules matching
 * 3. Dangerous operation detection
 * 4. Zod schema validation
 */

import { describe, it, expect } from 'vitest';
import {
  CockpitGateway,
  WebSocketMessageSchema,
  OrchestratorRequestSchema,
  type ChatMessage,
  type CommandMessage,
  type HeartbeatMessage,
  type WebSocketMessage,
} from './cockpit-gateway';

describe('CockpitGateway', () => {
  const gateway = new CockpitGateway();

  describe('analyzeMessage() - Delegation Rules', () => {
    it('should route UI-related messages to Pencil MCP', () => {
      const result = gateway.analyzeMessage('コンポーネントを作成してください');
      expect(result.suggestedAgent).toBe('Pencil MCP');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.keywords).toContain('コンポーネント');
    });

    it('should route page/button keywords to Pencil MCP', () => {
      const result = gateway.analyzeMessage('ボタンを追加してページを更新');
      expect(result.suggestedAgent).toBe('Pencil MCP');
      expect(result.keywords.some(k => k.includes('ボタン') || k.includes('ページ'))).toBe(true);
    });

    it('should route .pen file requests to Pencil MCP', () => {
      const result = gateway.analyzeMessage('.penファイルを編集してデザイン実装');
      expect(result.suggestedAgent).toBe('Pencil MCP');
    });

    it('should route UI review messages to Gemini ui-reviewer', () => {
      // "デザインレビュー" specifically matches Gemini without triggering Pencil's UI patterns
      const result = gateway.analyzeMessage('デザインレビューをお願いします');
      expect(result.suggestedAgent).toBe('Gemini ui-reviewer');
    });

    it('should route idea/direction messages to Gemini', () => {
      // Use "アイデア" which matches Gemini's idea pattern
      const result = gateway.analyzeMessage('アイデアを出して方向性を決めたい');
      expect(result.suggestedAgent).toBe('Gemini ui-reviewer');
    });

    it('should route security messages to Codex security-analyst', () => {
      const result = gateway.analyzeMessage('セキュリティの脆弱性をチェック');
      expect(result.suggestedAgent).toBe('Codex security-analyst');
    });

    it('should route authentication messages to Codex security-analyst', () => {
      const result = gateway.analyzeMessage('認証フローを確認してJWTを検証');
      expect(result.suggestedAgent).toBe('Codex security-analyst');
    });

    it('should route architecture messages to Codex architect', () => {
      const result = gateway.analyzeMessage('アーキテクチャを設計してスキーマを作成');
      expect(result.suggestedAgent).toBe('Codex architect');
    });

    it('should route code review messages to GLM code-reviewer', () => {
      // Use "バグ" which only matches GLM code-reviewer, not Gemini
      const result = gateway.analyzeMessage('バグを修正してパフォーマンス改善');
      expect(result.suggestedAgent).toBe('GLM code-reviewer');
    });

    it('should route math messages to GLM math-reasoning', () => {
      // Use only math-related keywords without "最適化" which matches code-reviewer
      const result = gateway.analyzeMessage('数学の計算ロジックを確認');
      expect(result.suggestedAgent).toBe('GLM math-reasoning');
    });

    it('should return default agent for unmatched messages', () => {
      const result = gateway.analyzeMessage('今日の天気は？');
      expect(result.suggestedAgent).toBe('GLM general-reviewer');
      expect(result.confidence).toBe(0);
    });

    it('should use Set for O(1) keyword uniqueness', () => {
      // Same keyword appearing multiple times should only be counted once
      const result = gateway.analyzeMessage('UIのUIコンポーネントのUI');
      expect(result.keywords.filter(k => k === 'ui').length).toBe(1);
    });
  });

  describe('transformToOrchestratorRequest() - Message Transformation', () => {
    it('should transform chat message correctly', () => {
      const message: ChatMessage = {
        type: 'chat',
        payload: {
          message: 'テストメッセージ',
          context: { foo: 'bar' },
        },
      };

      const request = gateway.transformToOrchestratorRequest(message, 'user-123');

      expect(request.id).toBeDefined();
      expect(request.source).toBe('cockpit');
      expect(request.messageType).toBe('chat');
      expect(request.content).toBe('テストメッセージ');
      expect(request.context).toEqual({ foo: 'bar' });
      expect(request.userId).toBe('user-123');
      expect(request.timestamp).toBeGreaterThan(0);
    });

    it('should transform command message correctly', () => {
      const message: CommandMessage = {
        type: 'command',
        payload: {
          command: 'deploy',
          args: ['--env', 'production'],
        },
      };

      const request = gateway.transformToOrchestratorRequest(message, 'user-456');

      expect(request.messageType).toBe('command');
      expect(request.content).toBe('/deploy --env production');
      expect(request.context).toBeUndefined();
    });

    it('should handle command without args', () => {
      const message: CommandMessage = {
        type: 'command',
        payload: {
          command: 'status',
        },
      };

      const request = gateway.transformToOrchestratorRequest(message, 'user-789');
      expect(request.content).toBe('/status');
    });

    it('should transform heartbeat message correctly', () => {
      const message: HeartbeatMessage = {
        type: 'heartbeat',
        payload: {
          message: '今日の予定: 会議3件',
          type: 'Morning Start',
          source: 'OpenClaw HEARTBEAT',
        },
      };

      const request = gateway.transformToOrchestratorRequest(message, 'user-999');

      expect(request.messageType).toBe('heartbeat');
      expect(request.content).toBe('今日の予定: 会議3件');
      expect(request.context).toEqual({
        heartbeatType: 'Morning Start',
        heartbeatSource: 'OpenClaw HEARTBEAT',
      });
      expect(request.delegationHints.suggestedAgent).toBe('none');
      expect(request.delegationHints.confidence).toBe(1.0);
      expect(request.delegationHints.keywords).toContain('heartbeat');
    });

    it('should handle heartbeat message without optional fields', () => {
      const message: HeartbeatMessage = {
        type: 'heartbeat',
        payload: {
          message: 'HEARTBEAT_OK',
        },
      };

      const request = gateway.transformToOrchestratorRequest(message, 'user-000');

      expect(request.messageType).toBe('heartbeat');
      expect(request.content).toBe('HEARTBEAT_OK');
      expect(request.context).toEqual({
        heartbeatType: undefined,
        heartbeatSource: undefined,
      });
    });

    it('should generate unique IDs', () => {
      const message: ChatMessage = {
        type: 'chat',
        payload: { message: 'test' },
      };

      const request1 = gateway.transformToOrchestratorRequest(message, 'user');
      const request2 = gateway.transformToOrchestratorRequest(message, 'user');

      expect(request1.id).not.toBe(request2.id);
    });
  });

  describe('processMessage() - Full Processing', () => {
    it('should process chat message and return routing decision', async () => {
      const message: ChatMessage = {
        type: 'chat',
        payload: { message: 'セキュリティ監査をお願い' },
      };

      const result = await gateway.processMessage(message, 'user-123');

      expect(result.request).toBeDefined();
      expect(result.routingDecision.agent).toBe('Codex security-analyst');
      expect(result.routingDecision.confidence).toBeGreaterThan(0);
      expect(result.routingDecision.requiresConsensus).toBe(false);
    });

    it('should detect dangerous operations requiring consensus', async () => {
      const message: ChatMessage = {
        type: 'chat',
        payload: { message: 'production環境にforce pushして' },
      };

      const result = await gateway.processMessage(message, 'user-123');

      expect(result.routingDecision.requiresConsensus).toBe(true);
    });

    it('should flag delete operations as requiring consensus', async () => {
      const message: CommandMessage = {
        type: 'command',
        payload: {
          command: 'rm',
          args: ['-rf', '/data'],
        },
      };

      const result = await gateway.processMessage(message, 'user-123');

      expect(result.routingDecision.requiresConsensus).toBe(true);
    });

    it('should flag sudo operations as requiring consensus', async () => {
      const message: ChatMessage = {
        type: 'chat',
        payload: { message: 'sudoでchmodを実行' },
      };

      const result = await gateway.processMessage(message, 'user-123');

      expect(result.routingDecision.requiresConsensus).toBe(true);
    });

    it('should flag main branch operations as requiring consensus', async () => {
      const message: ChatMessage = {
        type: 'chat',
        payload: { message: 'mainブランチをreset --hard' },
      };

      const result = await gateway.processMessage(message, 'user-123');

      expect(result.routingDecision.requiresConsensus).toBe(true);
    });

    it('should process heartbeat message without requiring consensus', async () => {
      const message: HeartbeatMessage = {
        type: 'heartbeat',
        payload: {
          message: 'Morning Start: 今日の予定を確認してください',
          type: 'Morning Start',
          source: 'OpenClaw HEARTBEAT',
        },
      };

      const result = await gateway.processMessage(message, 'user-123');

      expect(result.request).toBeDefined();
      expect(result.request.messageType).toBe('heartbeat');
      expect(result.routingDecision.agent).toBe('none');
      expect(result.routingDecision.confidence).toBe(1.0);
      expect(result.routingDecision.requiresConsensus).toBe(false);
    });
  });

  describe('Zod Schema Validation', () => {
    it('should validate chat message schema', () => {
      const validChat = {
        type: 'chat',
        payload: {
          message: 'Hello',
          context: { key: 'value' },
        },
      };

      const result = WebSocketMessageSchema.safeParse(validChat);
      expect(result.success).toBe(true);
    });

    it('should reject empty chat message', () => {
      const invalidChat = {
        type: 'chat',
        payload: {
          message: '',
        },
      };

      const result = WebSocketMessageSchema.safeParse(invalidChat);
      expect(result.success).toBe(false);
    });

    it('should reject message exceeding max length', () => {
      const invalidChat = {
        type: 'chat',
        payload: {
          message: 'x'.repeat(10001),
        },
      };

      const result = WebSocketMessageSchema.safeParse(invalidChat);
      expect(result.success).toBe(false);
    });

    it('should validate command message schema', () => {
      const validCommand = {
        type: 'command',
        payload: {
          command: 'deploy',
          args: ['--production'],
        },
      };

      const result = WebSocketMessageSchema.safeParse(validCommand);
      expect(result.success).toBe(true);
    });

    it('should validate heartbeat message schema', () => {
      const validHeartbeat = {
        type: 'heartbeat',
        payload: {
          message: 'Morning Start: 今日の予定をお知らせします',
          type: 'Morning Start',
          source: 'OpenClaw HEARTBEAT',
        },
      };

      const result = WebSocketMessageSchema.safeParse(validHeartbeat);
      expect(result.success).toBe(true);
    });

    it('should validate heartbeat message without optional fields', () => {
      const validHeartbeat = {
        type: 'heartbeat',
        payload: {
          message: 'HEARTBEAT_OK',
        },
      };

      const result = WebSocketMessageSchema.safeParse(validHeartbeat);
      expect(result.success).toBe(true);
    });

    it('should reject empty heartbeat message', () => {
      const invalidHeartbeat = {
        type: 'heartbeat',
        payload: {
          message: '',
        },
      };

      const result = WebSocketMessageSchema.safeParse(invalidHeartbeat);
      expect(result.success).toBe(false);
    });

    it('should reject heartbeat message exceeding max length', () => {
      const invalidHeartbeat = {
        type: 'heartbeat',
        payload: {
          message: 'x'.repeat(10001),
        },
      };

      const result = WebSocketMessageSchema.safeParse(invalidHeartbeat);
      expect(result.success).toBe(false);
    });

    it('should validate OrchestratorRequest schema', () => {
      const validRequest = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        source: 'cockpit',
        messageType: 'chat',
        content: 'Test content',
        delegationHints: {
          suggestedAgent: 'GLM general-reviewer',
          confidence: 0.5,
          keywords: ['test'],
        },
        userId: 'user-123',
        timestamp: Date.now(),
      };

      const result = OrchestratorRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should validate OrchestratorRequest with heartbeat messageType', () => {
      const validRequest = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        source: 'cockpit',
        messageType: 'heartbeat',
        content: 'Morning Start notification',
        context: {
          heartbeatType: 'Morning Start',
          heartbeatSource: 'OpenClaw HEARTBEAT',
        },
        delegationHints: {
          suggestedAgent: 'none',
          confidence: 1.0,
          keywords: ['heartbeat'],
        },
        userId: 'user-123',
        timestamp: Date.now(),
      };

      const result = OrchestratorRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should reject invalid UUID in OrchestratorRequest', () => {
      const invalidRequest = {
        id: 'not-a-uuid',
        source: 'cockpit',
        messageType: 'chat',
        content: 'Test',
        delegationHints: {
          suggestedAgent: 'test',
          confidence: 0.5,
          keywords: [],
        },
        userId: 'user-123',
        timestamp: Date.now(),
      };

      const result = OrchestratorRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should reject confidence out of range', () => {
      const invalidRequest = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        source: 'cockpit',
        messageType: 'chat',
        content: 'Test',
        delegationHints: {
          suggestedAgent: 'test',
          confidence: 1.5, // Should be 0-1
          keywords: [],
        },
        userId: 'user-123',
        timestamp: Date.now(),
      };

      const result = OrchestratorRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('Priority-based Routing', () => {
    it('should prioritize higher priority rules', () => {
      // UI (priority 100) should win over code review (priority 60)
      const result = gateway.analyzeMessage('コンポーネントのコードレビュー');
      expect(result.suggestedAgent).toBe('Pencil MCP');
    });

    it('should prioritize security over general review', () => {
      // Security (priority 80) should win over code review (priority 60)
      const result = gateway.analyzeMessage('認証コードをレビュー');
      expect(result.suggestedAgent).toBe('Codex security-analyst');
    });
  });
});
