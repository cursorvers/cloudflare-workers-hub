import type { OverridePermission } from './types';

export type AutopilotRole = 'admin' | 'operator' | 'viewer';

const ROLE_LEVEL: Readonly<Record<AutopilotRole, number>> = Object.freeze({
  viewer: 1,
  operator: 2,
  admin: 3,
});

function freezePermission(result: OverridePermission): OverridePermission {
  return Object.freeze({ ...result });
}

export function hasMinimumRole(
  actual: AutopilotRole | null,
  required: AutopilotRole,
): boolean {
  if (!actual) return false;
  return ROLE_LEVEL[actual] >= ROLE_LEVEL[required];
}

export function checkOverridePermission(
  role: AutopilotRole | null,
): OverridePermission {
  if (hasMinimumRole(role, 'admin')) {
    return freezePermission({ allowed: true, reason: 'override allowed for admin' });
  }

  return freezePermission({ allowed: false, reason: 'override requires admin role' });
}

export function canExecuteAction(
  role: AutopilotRole | null,
  action: 'read' | 'write' | 'override' | 'stop',
): boolean {
  switch (action) {
    case 'read':
      return hasMinimumRole(role, 'viewer');
    case 'write':
      return hasMinimumRole(role, 'operator');
    case 'stop':
      return hasMinimumRole(role, 'operator');
    case 'override':
      return hasMinimumRole(role, 'admin');
    default:
      return false;
  }
}
