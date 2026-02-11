import { describe, expect, it } from 'vitest';

import { normalizeAutopilotInput } from '../pipeline';

describe('schemas/pipeline', () => {
  describe('normalizeAutopilotInput', () => {
    it('returns success for valid YAML and frozen normalized data', () => {
      const yaml = [
        'meta:',
        '  project: demo',
        'tasks:',
        '  - id: t1',
        '    description: ship',
      ].join('\n');

      const result = normalizeAutopilotInput(yaml, 'trace-valid');
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected normalization success');

      expect(result.traceId).toBe('trace-valid');
      expect(result.data.meta.project).toBe('demo');
      expect(result.data.tasks).toHaveLength(1);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.data)).toBe(true);
      expect(Object.isFrozen(result.data.meta)).toBe(true);
    });

    it('returns error for invalid YAML syntax', () => {
      const invalidYaml = 'meta:\n  project: demo\n  mode: [autopilot';
      const result = normalizeAutopilotInput(invalidYaml, 'trace-yaml-error');

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected normalization failure');

      expect(result.traceId).toBe('trace-yaml-error');
      expect(result.error.length).toBeGreaterThan(0);
    });

    it('returns zod error for schema-invalid YAML data', () => {
      const yaml = [
        'tasks:',
        '  - id: t1',
        '    description: risky',
        '    risk_tier: 99',
      ].join('\n');

      const result = normalizeAutopilotInput(yaml, 'trace-schema-error');
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected normalization failure');

      expect(result.error).toContain('tasks.0.risk_tier');
    });

    it('strips unknown keys during normalization', () => {
      const yaml = [
        'unknownRoot: true',
        'meta:',
        '  project: demo',
        '  unknownMeta: 123',
        'tasks:',
        '  - id: t1',
        '    description: d1',
        '    unknownTask: x',
      ].join('\n');

      const result = normalizeAutopilotInput(yaml, 'trace-strip');
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected normalization success');

      expect((result.data as Record<string, unknown>)).not.toHaveProperty(
        'unknownRoot',
      );
      expect((result.data.meta as Record<string, unknown>)).not.toHaveProperty(
        'unknownMeta',
      );
      expect(
        (result.data.tasks[0] as Record<string, unknown>),
      ).not.toHaveProperty('unknownTask');
    });

    it('fills defaults when YAML is an empty object', () => {
      const result = normalizeAutopilotInput('{}', 'trace-defaults');
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected normalization success');

      expect(result.data.meta.project).toBe('unnamed');
      expect(result.data.meta.mode).toBe('collaborative');
      expect(result.data.governance.vote_quorum).toBe(2);
      expect(result.data.tasks).toEqual([]);
      expect(result.data.notifications.on_complete).toEqual(['github_issue']);
    });

    it('returns deeply frozen output', () => {
      const yaml = [
        'tasks:',
        '  - id: t1',
        '    description: d1',
      ].join('\n');

      const result = normalizeAutopilotInput(yaml, 'trace-freeze');
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected normalization success');

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.data)).toBe(true);
      expect(Object.isFrozen(result.data.tasks)).toBe(true);
      expect(Object.isFrozen(result.data.tasks[0])).toBe(true);
    });
  });
});
