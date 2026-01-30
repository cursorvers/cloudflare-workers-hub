/**
 * FUGUE Integration - CockpitGateway
 *
 * Transforms WebSocket messages from Cockpit PWA into OrchestratorRequest format
 * and routes to appropriate agents based on delegation-matrix.md rules.
 *
 * Flow:
 * Cockpit PWA → WebSocket → CockpitGateway → OrchestratorRequest → Agent Delegation
 */

import { z } from 'zod';

// =============================================================================
// Type Definitions
// =============================================================================

export interface ChatMessage {
  type: 'chat';
  payload: { message: string; context?: Record<string, unknown> };
}

export interface CommandMessage {
  type: 'command';
  payload: { command: string; args?: string[] };
}

export type WebSocketMessage = ChatMessage | CommandMessage;

export interface DelegationHints {
  suggestedAgent: string;
  confidence: number;
  keywords: string[];
}

export interface OrchestratorRequest {
  id: string;
  source: 'cockpit';
  messageType: 'chat' | 'command';
  content: string;
  context?: Record<string, unknown>;
  delegationHints: DelegationHints;
  userId: string;
  timestamp: number;
}

// =============================================================================
// Delegation Rules (from delegation-matrix.md)
// =============================================================================

interface DelegationRule {
  agent: string;
  patterns: RegExp[];
  priority: number; // Higher = checked first
}

/**
 * Delegation rules based on delegation-matrix.md
 * Priority order ensures more specific matches are checked first
 * Note: Using non-word-boundary patterns for Japanese text compatibility
 */
const DELEGATION_RULES: DelegationRule[] = [
  // UI/UX - Pencil MCP (highest priority for UI implementation)
  {
    agent: 'Pencil MCP',
    patterns: [
      /(ui|コンポーネント|component|画面|ページ|page|ボタン|button|フォーム|form|モーダル|modal|カード|card|ダッシュボード|dashboard|レイアウト|layout)/i,
      /(\.pen|pencil|デザイン実装|design implementation)/i,
    ],
    priority: 100,
  },
  // UI/UX - Gemini for ideas and review
  {
    agent: 'Gemini ui-reviewer',
    patterns: [
      /(ui.*レビュー|ux.*レビュー|デザイン.*レビュー|ui review|ux review|design review)/i,
      /(配色|color scheme|アイデア|idea|提案|suggest|方向性|direction)/i,
    ],
    priority: 90,
  },
  // Security - Codex (high priority for security matters)
  {
    agent: 'Codex security-analyst',
    patterns: [
      /(security|セキュリティ|auth|認証|authentication|authorization|vulnerability|脆弱性|injection|xss|csrf|token|jwt)/i,
      /(password|credential|secret|暗号化|encryption)/i,
    ],
    priority: 80,
  },
  // Architecture/Design - Codex
  {
    agent: 'Codex architect',
    patterns: [
      /(architect|アーキテクチャ|設計|design pattern|構成|structure|schema|database design)/i,
    ],
    priority: 70,
  },
  // Code Review - GLM
  {
    agent: 'GLM code-reviewer',
    patterns: [
      /(code review|コードレビュー|refactor|リファクタ|optimize|最適化|performance|パフォーマンス|bug|バグ|error handling)/i,
    ],
    priority: 60,
  },
  // Math/Algorithm - GLM
  {
    agent: 'GLM math-reasoning',
    patterns: [
      /(math|数学|algorithm|アルゴリズム|calculate|計算|logic|ロジック)/i,
    ],
    priority: 50,
  },
];

const DEFAULT_AGENT = 'GLM general-reviewer';

// =============================================================================
// CockpitGateway Class
// =============================================================================

export class CockpitGateway {
  /**
   * Analyze message content to determine delegation hints
   * Uses Set for O(1) keyword uniqueness check (GLM review feedback)
   */
  public analyzeMessage(content: string): DelegationHints {
    let bestMatch: DelegationRule | null = null;
    let maxScore = 0;
    const matchedKeywords = new Set<string>();

    // Sort rules by priority (descending)
    const sortedRules = [...DELEGATION_RULES].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      let currentScore = 0;

      for (const pattern of rule.patterns) {
        const matches = content.match(pattern);
        if (matches) {
          currentScore += matches.length * (rule.priority / 10); // Weight by priority
          matches.forEach(m => matchedKeywords.add(m.toLowerCase()));
        }
      }

      if (currentScore > maxScore) {
        maxScore = currentScore;
        bestMatch = rule;
      }
    }

    // Calculate confidence (0.0 to 1.0)
    // Higher score and priority = higher confidence
    const confidence = maxScore === 0 ? 0 : Math.min(maxScore / 30, 1.0);

    return {
      suggestedAgent: bestMatch ? bestMatch.agent : DEFAULT_AGENT,
      confidence,
      keywords: Array.from(matchedKeywords),
    };
  }

  /**
   * Transform WebSocket message to OrchestratorRequest
   */
  public transformToOrchestratorRequest(
    message: WebSocketMessage,
    userId: string
  ): OrchestratorRequest {
    let content: string;
    let context: Record<string, unknown> | undefined;

    if (message.type === 'chat') {
      content = message.payload.message;
      context = message.payload.context;
    } else {
      // Command: join command and args
      const argsStr = message.payload.args ? message.payload.args.join(' ') : '';
      content = `/${message.payload.command} ${argsStr}`.trim();
    }

    const delegationHints = this.analyzeMessage(content);

    return {
      id: crypto.randomUUID(),
      source: 'cockpit',
      messageType: message.type,
      content,
      context,
      delegationHints,
      userId,
      timestamp: Date.now(),
    };
  }

  /**
   * Process message and return routing information
   * This is the main entry point for the gateway
   */
  public async processMessage(
    message: WebSocketMessage,
    userId: string
  ): Promise<{
    request: OrchestratorRequest;
    routingDecision: {
      agent: string;
      confidence: number;
      requiresConsensus: boolean;
    };
  }> {
    const request = this.transformToOrchestratorRequest(message, userId);

    // Determine if consensus is required (dangerous operations)
    const requiresConsensus = this.checkRequiresConsensus(request.content);

    return {
      request,
      routingDecision: {
        agent: request.delegationHints.suggestedAgent,
        confidence: request.delegationHints.confidence,
        requiresConsensus,
      },
    };
  }

  /**
   * Check if the operation requires 3-party consensus
   * Based on dangerous-permission-consensus.md rules
   */
  private checkRequiresConsensus(content: string): boolean {
    const dangerousPatterns = [
      /\b(production|本番|main|master)\b/i,
      /\b(force push|--force|--hard|reset)\b/i,
      /\b(delete|削除|rm -rf|drop)\b/i,
      /\b(sudo|chmod|credentials|secret)\b/i,
    ];

    return dangerousPatterns.some(pattern => pattern.test(content));
  }
}

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

export const ChatMessageSchema = z.object({
  type: z.literal('chat'),
  payload: z.object({
    message: z.string().min(1).max(10000),
    context: z.record(z.unknown()).optional(),
  }),
});

export const CommandMessageSchema = z.object({
  type: z.literal('command'),
  payload: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  }),
});

export const WebSocketMessageSchema = z.discriminatedUnion('type', [
  ChatMessageSchema,
  CommandMessageSchema,
]);

export const OrchestratorRequestSchema = z.object({
  id: z.string().uuid(),
  source: z.literal('cockpit'),
  messageType: z.enum(['chat', 'command']),
  content: z.string(),
  context: z.record(z.unknown()).optional(),
  delegationHints: z.object({
    suggestedAgent: z.string(),
    confidence: z.number().min(0).max(1),
    keywords: z.array(z.string()),
  }),
  userId: z.string(),
  timestamp: z.number(),
});
