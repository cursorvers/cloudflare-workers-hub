/**
 * Session Memory Manager
 *
 * セッション間で作業状態を自動保存・復元する。
 * agent-memory skill と連携して永続化を実現。
 */

import { SummaryGenerator, SummaryResult } from './summary-generator';
import { ConversationRingBuffer } from './lazy-loader';

export interface SessionState {
  sessionId: string;
  startedAt: string;
  lastUpdatedAt: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  context: SessionContext;
  conversationHistory: string[];
  checkpoints: Checkpoint[];
}

export interface SessionContext {
  currentTask: string;
  completedTasks: string[];
  pendingTasks: string[];
  decisions: Decision[];
  observations: string[];
}

export interface Decision {
  timestamp: string;
  topic: string;
  choice: string;
  rationale: string;
  source: 'claude' | 'codex' | 'glm' | 'gemini' | 'user';
}

export interface Checkpoint {
  id: string;
  timestamp: string;
  description: string;
  state: Partial<SessionContext>;
}

export interface MemoryFile {
  path: string;
  content: string;
  category: 'investigations' | 'decisions' | 'in-progress' | 'troubleshooting';
}

const MEMORY_BASE_PATH = '~/.claude/skills/agent-memory/memories';

export class SessionMemoryManager {
  private state: SessionState;
  private ringBuffer: ConversationRingBuffer;
  private summaryGenerator: SummaryGenerator;
  private autoSaveInterval: number;

  constructor(options: {
    sessionId?: string;
    autoSaveIntervalMs?: number;
    maxConversationTurns?: number;
  } = {}) {
    this.ringBuffer = new ConversationRingBuffer(options.maxConversationTurns ?? 10);
    this.summaryGenerator = new SummaryGenerator({ maxTokens: 500 });
    this.autoSaveInterval = options.autoSaveIntervalMs ?? 300000; // 5 minutes

    this.state = {
      sessionId: options.sessionId ?? this.generateSessionId(),
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      status: 'active',
      context: {
        currentTask: '',
        completedTasks: [],
        pendingTasks: [],
        decisions: [],
        observations: [],
      },
      conversationHistory: [],
      checkpoints: [],
    };
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  /**
   * Record a conversation turn
   */
  recordTurn(content: string): void {
    this.ringBuffer.push(content);
    this.state.conversationHistory = this.ringBuffer.getRecent();
    this.state.lastUpdatedAt = new Date().toISOString();
  }

  /**
   * Record a decision
   */
  recordDecision(decision: Omit<Decision, 'timestamp'>): void {
    this.state.context.decisions.push({
      ...decision,
      timestamp: new Date().toISOString(),
    });
    this.state.lastUpdatedAt = new Date().toISOString();
  }

  /**
   * Record an observation
   */
  recordObservation(observation: string): void {
    this.state.context.observations.push(observation);
    this.state.lastUpdatedAt = new Date().toISOString();
  }

  /**
   * Update task status
   */
  updateTask(task: string, status: 'start' | 'complete' | 'pending'): void {
    switch (status) {
      case 'start':
        this.state.context.currentTask = task;
        break;
      case 'complete':
        this.state.context.completedTasks.push(task);
        if (this.state.context.currentTask === task) {
          this.state.context.currentTask = '';
        }
        break;
      case 'pending':
        this.state.context.pendingTasks.push(task);
        break;
    }
    this.state.lastUpdatedAt = new Date().toISOString();
  }

  /**
   * Create a checkpoint
   */
  createCheckpoint(description: string): Checkpoint {
    const checkpoint: Checkpoint = {
      id: `cp_${Date.now()}`,
      timestamp: new Date().toISOString(),
      description,
      state: { ...this.state.context },
    };
    this.state.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /**
   * Generate memory file content for agent-memory skill
   */
  generateMemoryFile(): MemoryFile {
    const summary = this.summaryGenerator.summarize(
      JSON.stringify(this.state.context, null, 2),
      'codex'
    );

    const content = `---
summary: "${this.state.context.currentTask || 'Session in progress'}"
created: ${this.state.startedAt.split('T')[0]}
updated: ${this.state.lastUpdatedAt.split('T')[0]}
status: ${this.state.status}
tags: [session, auto-saved]
---

# Session: ${this.state.sessionId}

## Current Task
${this.state.context.currentTask || 'No active task'}

## Completed
${this.state.context.completedTasks.map(t => `- [x] ${t}`).join('\n') || 'None'}

## Pending
${this.state.context.pendingTasks.map(t => `- [ ] ${t}`).join('\n') || 'None'}

## Key Decisions
${this.state.context.decisions.slice(-5).map(d =>
  `- **${d.topic}**: ${d.choice} (${d.source})`
).join('\n') || 'None'}

## Observations
${this.state.context.observations.slice(-5).map(o => `- ${o}`).join('\n') || 'None'}

## Recent Conversation
${this.ringBuffer.getRecent(5).map(t => `> ${t.substring(0, 100)}...`).join('\n') || 'None'}
`;

    return {
      path: `${MEMORY_BASE_PATH}/in-progress/${this.state.sessionId}.md`,
      content,
      category: 'in-progress',
    };
  }

  /**
   * Export state for persistence
   */
  exportState(): SessionState {
    return { ...this.state };
  }

  /**
   * Import state from persistence
   */
  importState(state: SessionState): void {
    this.state = state;
    this.state.conversationHistory.forEach(turn => this.ringBuffer.push(turn));
  }

  /**
   * Mark session as completed
   */
  complete(): void {
    this.state.status = 'completed';
    this.state.lastUpdatedAt = new Date().toISOString();
  }

  /**
   * Mark session as paused
   */
  pause(): void {
    this.state.status = 'paused';
    this.state.lastUpdatedAt = new Date().toISOString();
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  get status(): SessionState['status'] {
    return this.state.status;
  }
}

export default SessionMemoryManager;
