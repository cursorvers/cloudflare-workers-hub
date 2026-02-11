import { describe, expect, it } from 'vitest';

import { canExecuteAction, checkOverridePermission, hasMinimumRole } from '../rbac';

describe('autopilot/auth/rbac', () => {
  it('admin → override許可', () => {
    const result = checkOverridePermission('admin');

    expect(result.allowed).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('operator → override拒否', () => {
    const result = checkOverridePermission('operator');

    expect(result.allowed).toBe(false);
  });

  it('role階層チェック', () => {
    expect(hasMinimumRole('admin', 'viewer')).toBe(true);
    expect(hasMinimumRole('operator', 'admin')).toBe(false);
    expect(hasMinimumRole('viewer', 'viewer')).toBe(true);
    expect(hasMinimumRole(null, 'viewer')).toBe(false);

    expect(canExecuteAction('admin', 'override')).toBe(true);
    expect(canExecuteAction('operator', 'override')).toBe(false);
    expect(canExecuteAction('operator', 'write')).toBe(true);
    expect(canExecuteAction('viewer', 'read')).toBe(true);
    expect(canExecuteAction('viewer', 'write')).toBe(false);
  });
});
