import { describe, expect, it } from 'vitest';

import {
  checkHeartbeat,
  createHeartbeatState,
  DEFAULT_HEARTBEAT_CONFIG,
  recordHeartbeat,
} from '../heartbeat';

describe('runtime/heartbeat', () => {
  it('初期状態でgrace period内はALIVE', () => {
    const state = createHeartbeatState(1000);
    const result = checkHeartbeat(state, DEFAULT_HEARTBEAT_CONFIG, 1500);

    expect(result.status).toBe('ALIVE');
    expect(result.shouldStop).toBe(false);
    expect(result.msSinceLastBeat).toBeNull();
  });

  it('heartbeat受信でALIVE', () => {
    const state = createHeartbeatState(1000);
    const withBeat = recordHeartbeat(state, 2000);
    const result = checkHeartbeat(withBeat, DEFAULT_HEARTBEAT_CONFIG, 2500);

    expect(result.status).toBe('ALIVE');
    expect(result.shouldStop).toBe(false);
    expect(result.msSinceLastBeat).toBe(500);
  });

  it('interval超過でLATE', () => {
    const state = createHeartbeatState(1000);
    const withBeat = recordHeartbeat(state, 2000);
    const result = checkHeartbeat(withBeat, DEFAULT_HEARTBEAT_CONFIG, 12001);

    expect(result.status).toBe('LATE');
    expect(result.shouldStop).toBe(false);
    expect(result.msSinceLastBeat).toBe(10001);
  });

  it('dead threshold超過でDEAD', () => {
    const state = createHeartbeatState(1000);
    const withBeat = recordHeartbeat(state, 2000);
    const result = checkHeartbeat(withBeat, DEFAULT_HEARTBEAT_CONFIG, 32000);

    expect(result.status).toBe('DEAD');
    expect(result.msSinceLastBeat).toBe(30000);
  });

  it('grace period内はheartbeatなしでもALIVE', () => {
    const state = createHeartbeatState(1000);
    const result = checkHeartbeat(state, DEFAULT_HEARTBEAT_CONFIG, 31000);

    expect(result.status).toBe('ALIVE');
    expect(result.shouldStop).toBe(false);
    expect(result.msSinceLastBeat).toBeNull();
  });

  it('recordHeartbeatで変性', () => {
    const state = createHeartbeatState(1000);
    const next = recordHeartbeat(state, 2000);

    expect(next).not.toBe(state);
    expect(state.lastHeartbeatMs).toBeNull();
    expect(state.totalHeartbeats).toBe(0);
    expect(next.lastHeartbeatMs).toBe(2000);
    expect(next.totalHeartbeats).toBe(1);
    expect(next.consecutiveMisses).toBe(0);
  });

  it('DEAD時shouldStop=true', () => {
    const state = createHeartbeatState(1000);
    const withBeat = recordHeartbeat(state, 2000);
    const result = checkHeartbeat(withBeat, DEFAULT_HEARTBEAT_CONFIG, 35000);

    expect(result.status).toBe('DEAD');
    expect(result.shouldStop).toBe(true);
  });

  it('全結果がObject.freeze', () => {
    const state = createHeartbeatState(1000);
    const beat = recordHeartbeat(state, 2000);
    const alive = checkHeartbeat(beat, DEFAULT_HEARTBEAT_CONFIG, 2500);
    const late = checkHeartbeat(beat, DEFAULT_HEARTBEAT_CONFIG, 12001);
    const dead = checkHeartbeat(beat, DEFAULT_HEARTBEAT_CONFIG, 35000);

    expect(Object.isFrozen(DEFAULT_HEARTBEAT_CONFIG)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(beat)).toBe(true);
    expect(Object.isFrozen(alive)).toBe(true);
    expect(Object.isFrozen(late)).toBe(true);
    expect(Object.isFrozen(dead)).toBe(true);
  });
});
