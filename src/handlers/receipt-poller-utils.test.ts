import { describe, expect, it } from 'vitest';

import { resolveOperationalTenantId } from './receipt-poller-utils';

function makeEnv(results: Array<{ tenant_id: string }>, configuredTenant?: string) {
  return {
    DB: {
      prepare: (sql: string) => ({
        all: async () => ({ results }),
        bind: (...args: unknown[]) => {
          const firstArg = args[0];
          return {
            first: async () => {
              if (sql.includes('WHERE tenant_id = ?')) {
                return results.find((row) => row.tenant_id === firstArg) ?? null;
              }
              return null;
            },
            all: async () => ({ results }),
          };
        },
      }),
    },
    RECEIPT_OPERATIONAL_TENANT_ID: configuredTenant,
  } as any;
}

describe('resolveOperationalTenantId', () => {
  it('returns the only active tenant when exactly one exists', async () => {
    const tenantId = await resolveOperationalTenantId(makeEnv([{ tenant_id: 'tenant-1' }]));
    expect(tenantId).toBe('tenant-1');
  });

  it('uses configured operational tenant when present', async () => {
    const tenantId = await resolveOperationalTenantId(
      makeEnv([{ tenant_id: 'tenant-1' }, { tenant_id: 'tenant-2' }], 'tenant-2')
    );
    expect(tenantId).toBe('tenant-2');
  });

  it('throws when multiple active tenants exist without configuration', async () => {
    await expect(
      resolveOperationalTenantId(makeEnv([{ tenant_id: 'tenant-1' }, { tenant_id: 'tenant-2' }]))
    ).rejects.toThrow(/RECEIPT_OPERATIONAL_TENANT_ID/);
  });
});
