import { describe, expect, it } from 'vitest';

import { parseAutopilotYml } from '../schemas/autopilot-yml';

describe('schemas/autopilot-yml', () => {
  describe('parseAutopilotYml', () => {
    it('succeeds with all default values for empty object', () => {
      const result = parseAutopilotYml({});
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected parse success');

      expect(result.data).toEqual({
        meta: {
          project: 'unnamed',
          mode: 'collaborative',
          created_by: 'unknown',
          engaged_at: null,
        },
        governance: {
          vote_quorum: 2,
          claude_checkpoints: true,
          gemini_ui_review: true,
          grok_realtime: true,
          escalation_after: 3,
          risk_tiers: {
            tier_0: ['read', 'lint', 'test'],
            tier_1: ['single_file_edit'],
            tier_2: ['multi_file', 'design'],
            tier_3: ['delete', 'deploy', 'auth'],
            tier_4: ['production', 'irreversible'],
          },
        },
        pscsr: {
          default: 'auto',
          rounds: 3,
        },
        safety: {
          max_retry_per_task: 3,
          max_token_budget_per_task: 50_000,
          max_consecutive_failures: 2,
          circuit_breaker: true,
          idle_timeout_hours: 72,
          thrashing_detection: {
            max_fix_cycles: 3,
            similarity_threshold: 0.92,
          },
        },
        tasks: [],
        notifications: {
          on_complete: ['github_issue'],
          on_escalation: ['discord'],
          on_milestone: ['github_issue'],
        },
      });
    });

    it('accepts a v1.0-compatible shape (missing newer sections) and fills defaults', () => {
      const result = parseAutopilotYml({
        meta: {
          project: 'demo',
          created_by: 'tester',
        },
        tasks: [
          {
            id: 'task-1',
            description: 'Ship something',
          },
        ],
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected parse success');

      expect(result.data.meta).toEqual({
        project: 'demo',
        mode: 'collaborative',
        created_by: 'tester',
        engaged_at: null,
      });
      expect(result.data.tasks).toEqual([
        {
          id: 'task-1',
          description: 'Ship something',
          acceptance_criteria: [],
          priority: 'medium',
          dependencies: [],
          delegate_to: 'codex',
          pscsr: 'auto',
          risk_tier: 1,
        },
      ]);
      expect(result.data.governance.vote_quorum).toBe(2);
      expect(result.data.pscsr).toEqual({ default: 'auto', rounds: 3 });
      expect(result.data.notifications.on_complete).toEqual(['github_issue']);
    });

    it('fails with an error message for invalid input', () => {
      const result = parseAutopilotYml({
        tasks: [{ id: '', description: '' }],
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected parse failure');

      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).toContain('tasks.0.id');
      expect(result.error).toContain('tasks.0.description');
    });

    it('strips unknown properties', () => {
      const result = parseAutopilotYml({
        unknownRoot: true,
        meta: {
          project: 'p',
          unknownMeta: 123,
        },
        tasks: [
          {
            id: 't1',
            description: 'd1',
            unknownTask: { nested: 'x' },
          },
        ],
        governance: {
          vote_quorum: 2,
          unknownGovernance: 'x',
        },
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected parse success');

      expect((result.data as Record<string, unknown>)).not.toHaveProperty(
        'unknownRoot',
      );
      expect(
        (result.data.meta as Record<string, unknown>),
      ).not.toHaveProperty('unknownMeta');
      expect(
        (result.data.tasks[0] as Record<string, unknown>),
      ).not.toHaveProperty('unknownTask');
      expect(
        (result.data.governance as Record<string, unknown>),
      ).not.toHaveProperty('unknownGovernance');
    });
  });

  describe('TaskSchema validation', () => {
    it('rejects tasks missing id', () => {
      const result = parseAutopilotYml({
        tasks: [
          {
            description: 'missing id',
          },
        ],
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected parse failure');
      expect(result.error).toContain('tasks.0.id');
    });

    it('rejects empty id and empty description', () => {
      const result = parseAutopilotYml({
        tasks: [{ id: '', description: '' }],
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected parse failure');
      expect(result.error).toContain('tasks.0.id');
      expect(result.error).toContain('tasks.0.description');
    });

    it('rejects invalid priority enum', () => {
      const result = parseAutopilotYml({
        tasks: [
          {
            id: 't1',
            description: 'd1',
            priority: 'urgent',
          },
        ],
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected parse failure');
      expect(result.error).toContain('tasks.0.priority');
    });

    it('rejects invalid pscsr enum', () => {
      const result = parseAutopilotYml({
        tasks: [
          {
            id: 't1',
            description: 'd1',
            pscsr: 'sometimes',
          },
        ],
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected parse failure');
      expect(result.error).toContain('tasks.0.pscsr');
    });

    it('rejects out-of-range risk_tier', () => {
      const result = parseAutopilotYml({
        tasks: [
          {
            id: 't1',
            description: 'd1',
            risk_tier: 5,
          },
        ],
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected parse failure');
      expect(result.error).toContain('tasks.0.risk_tier');
    });

    it('rejects non-integer risk_tier', () => {
      const result = parseAutopilotYml({
        tasks: [
          {
            id: 't1',
            description: 'd1',
            risk_tier: 1.5,
          },
        ],
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected parse failure');
      expect(result.error).toContain('tasks.0.risk_tier');
    });

    it('rejects invalid acceptance_criteria type', () => {
      const result = parseAutopilotYml({
        tasks: [
          {
            id: 't1',
            description: 'd1',
            acceptance_criteria: 'must be array',
          },
        ],
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected parse failure');
      expect(result.error).toContain('tasks.0.acceptance_criteria');
    });
  });
});
