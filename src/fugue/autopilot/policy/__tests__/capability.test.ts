import { describe, expect, it, vi, afterEach } from 'vitest';

import { EFFECT_TYPES, ORIGINS } from '../../types';
import { consumeCapability, createCapability, isCapabilityValid } from '../capability';

afterEach(() => {
  vi.useRealTimers();
});

describe('policy/capability', () => {
  it('createCapability returns a frozen object with frozen arrays', () => {
    const cap = createCapability({
      id: 'cap-1',
      subjectId: 'u1',
      effects: [EFFECT_TYPES.EXEC],
      maxTier: 3,
      origins: [ORIGINS.CLI],
      expiresAt: '2026-02-12T00:00:00.000Z',
      maxUses: 2,
    });

    expect(Object.isFrozen(cap)).toBe(true);
    expect(Object.isFrozen(cap.effects)).toBe(true);
    expect(Object.isFrozen(cap.origins)).toBe(true);
    expect(cap.usedCount).toBe(0);
  });

  it('isCapabilityValid checks expiry and usage counts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T00:00:00.000Z'));

    const cap = createCapability({
      id: 'cap-2',
      subjectId: 'u1',
      effects: [EFFECT_TYPES.SECRET_READ],
      maxTier: 3,
      origins: [ORIGINS.CLI],
      expiresAt: '2026-02-11T00:00:00.001Z',
      maxUses: 1,
    });

    expect(isCapabilityValid(cap)).toBe(true);
    vi.setSystemTime(new Date('2026-02-11T00:00:00.001Z'));
    expect(isCapabilityValid(cap)).toBe(false);
  });

  it('consumeCapability returns a new frozen object and keeps the original unchanged', () => {
    const cap = createCapability({
      id: 'cap-3',
      subjectId: 'u1',
      effects: [EFFECT_TYPES.EXFIL],
      maxTier: 3,
      origins: [ORIGINS.CLI],
      expiresAt: '2026-02-12T00:00:00.000Z',
      maxUses: 3,
    });

    const next = consumeCapability(cap);

    expect(next).not.toBe(cap);
    expect(Object.isFrozen(next)).toBe(true);
    expect(next.usedCount).toBe(1);
    expect(cap.usedCount).toBe(0);
  });
});

