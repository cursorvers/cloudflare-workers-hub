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

export interface HeartbeatMessage {
  type: 'heartbeat';
  payload: {
    message: string;
    type?: string; // e.g., 'HEARTBEAT_OK', 'Morning Start', 'Midday Check', 'Evening Review'
    source?: string; // e.g., 'OpenClaw HEARTBEAT'
  };
}

export type WebSocketMessage = ChatMessage | CommandMessage | HeartbeatMessage;

export interface DelegationHints {
  suggestedAgent: string;
  confidence: number;
  keywords: string[];
}

export interface OrchestratorRequest {
  id: string;
  source: 'cockpit';
  messageType: 'chat' | 'command' | 'heartbeat';
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
const MIN_TEXT_LENGTH = 1;
const MAX_MESSAGE_LENGTH = 10000;
const PRIORITY_WEIGHT_DIVISOR = 10;
const CONFIDENCE_NORMALIZATION_FACTOR = 30;
const MIN_CONFIDENCE = 0;
const MAX_CONFIDENCE = 1;

const SORTED_DELEGATION_RULES = [...DELEGATION_RULES].sort(
  (a, b) => b.priority - a.priority
);

const DANGEROUS_PATTERNS = [
  /(?:^|\W)(production|本番|main|master)(?=\W|$)/i,
  /(?:^|\W)(force push|--force|--hard|reset)(?=\W|$)/i,
  /(?:^|\W)(delete|削除|rm -rf|drop)(?=\W|$)/i,
  /(?:^|\W)(sudo|chmod|credentials|secret)(?=\W|$)/i,
];

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

    for (const rule of SORTED_DELEGATION_RULES) {
      let currentScore = 0;

      for (const pattern of rule.patterns) {
        const matches = content.match(pattern);
        if (matches) {
          currentScore += matches.length * (rule.priority / PRIORITY_WEIGHT_DIVISOR); // Weight by priority
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
    const confidence = maxScore === 0
      ? MIN_CONFIDENCE
      : Math.min(maxScore / CONFIDENCE_NORMALIZATION_FACTOR, MAX_CONFIDENCE);

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
    } else if (message.type === 'command') {
      // Command: join command and args
      const argsStr = message.payload.args ? message.payload.args.join(' ') : '';
      content = `/${message.payload.command} ${argsStr}`.trim();
    } else {
      // Heartbeat: use message as-is, no delegation needed
      content = message.payload.message;
      context = {
        heartbeatType: message.payload.type,
        heartbeatSource: message.payload.source,
      };
    }

    // Skip delegation analysis for heartbeat messages
    const delegationHints =
      message.type === 'heartbeat'
        ? {
            suggestedAgent: 'none', // No delegation for heartbeat
            confidence: MAX_CONFIDENCE,
            keywords: ['heartbeat'],
          }
        : this.analyzeMessage(content);

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
  public processMessage(
    message: WebSocketMessage,
    userId: string
  ): {
    request: OrchestratorRequest;
    routingDecision: {
      agent: string;
      confidence: number;
      requiresConsensus: boolean;
    };
  } {
    const parsedMessage = WebSocketMessageSchema.parse(message);
    const request = this.transformToOrchestratorRequest(parsedMessage, userId);

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
    return DANGEROUS_PATTERNS.some(pattern => pattern.test(content));
  }
}

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

export const ChatMessageSchema = z.object({
  type: z.literal('chat'),
  payload: z.object({
    message: z.string().min(MIN_TEXT_LENGTH).max(MAX_MESSAGE_LENGTH),
    context: z.record(z.unknown()).optional(),
  }),
});

export const CommandMessageSchema = z.object({
  type: z.literal('command'),
  payload: z.object({
    command: z.string().min(MIN_TEXT_LENGTH),
    args: z.array(z.string()).optional(),
  }),
});

export const HeartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  payload: z.object({
    message: z.string().min(MIN_TEXT_LENGTH).max(MAX_MESSAGE_LENGTH),
    type: z.string().optional(),
    source: z.string().optional(),
  }),
});

export const WebSocketMessageSchema = z.discriminatedUnion('type', [
  ChatMessageSchema,
  CommandMessageSchema,
  HeartbeatMessageSchema,
]);

export const OrchestratorRequestSchema = z.object({
  id: z.string().uuid(),
  source: z.literal('cockpit'),
  messageType: z.enum(['chat', 'command', 'heartbeat']),
  content: z.string(),
  context: z.record(z.unknown()).optional(),
  delegationHints: z.object({
    suggestedAgent: z.string(),
    confidence: z.number().min(MIN_CONFIDENCE).max(MAX_CONFIDENCE),
    keywords: z.array(z.string()),
  }),
  userId: z.string(),
  timestamp: z.number(),
});
