/**
 * Tests for Router Utilities
 *
 * Tests covering:
 * - Source detection from URL paths
 * - Event ID generation format and uniqueness
 */

import { describe, it, expect } from 'vitest';
import { detectSource, generateEventId } from './router';

describe('Router Utilities', () => {
  // ==========================================================================
  // detectSource
  // ==========================================================================
  describe('detectSource', () => {
    it('should detect slack source', () => {
      const request = new Request('http://localhost/webhook/slack');
      expect(detectSource(request)).toBe('slack');
    });

    it('should detect discord source', () => {
      const request = new Request('http://localhost/webhook/discord');
      expect(detectSource(request)).toBe('discord');
    });

    it('should detect telegram source', () => {
      const request = new Request('http://localhost/webhook/telegram');
      expect(detectSource(request)).toBe('telegram');
    });

    it('should detect whatsapp source', () => {
      const request = new Request('http://localhost/webhook/whatsapp');
      expect(detectSource(request)).toBe('whatsapp');
    });

    it('should detect clawdbot source', () => {
      const request = new Request('http://localhost/webhook/clawdbot');
      expect(detectSource(request)).toBe('clawdbot');
    });

    it('should detect github source', () => {
      const request = new Request('http://localhost/webhook/github');
      expect(detectSource(request)).toBe('github');
    });

    it('should detect stripe source', () => {
      const request = new Request('http://localhost/webhook/stripe');
      expect(detectSource(request)).toBe('stripe');
    });

    it('should return unknown for unrecognized path', () => {
      const request = new Request('http://localhost/webhook/unknown');
      expect(detectSource(request)).toBe('unknown');
    });

    it('should return unknown for root path', () => {
      const request = new Request('http://localhost/');
      expect(detectSource(request)).toBe('unknown');
    });

    it('should detect source in nested paths', () => {
      const request = new Request('http://localhost/api/v1/slack/events');
      expect(detectSource(request)).toBe('slack');
    });

    it('should match first source when path contains multiple keywords', () => {
      // Since .includes() checks sequentially, /slack-discord would match 'slack' first
      const request = new Request('http://localhost/slack-discord');
      expect(detectSource(request)).toBe('slack');
    });

    it('should return unknown for /health endpoint', () => {
      const request = new Request('http://localhost/health');
      expect(detectSource(request)).toBe('unknown');
    });

    it('should return unknown for /api/queue endpoint', () => {
      const request = new Request('http://localhost/api/queue');
      expect(detectSource(request)).toBe('unknown');
    });
  });

  // ==========================================================================
  // generateEventId
  // ==========================================================================
  describe('generateEventId', () => {
    it('should start with evt_ prefix', () => {
      const id = generateEventId();
      expect(id.startsWith('evt_')).toBe(true);
    });

    it('should contain a timestamp component', () => {
      const id = generateEventId();
      const parts = id.split('_');
      // evt_<timestamp>_<random>
      expect(parts).toHaveLength(3);
      const timestamp = parseInt(parts[1], 10);
      expect(timestamp).toBeGreaterThan(0);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('should contain a random component', () => {
      const id = generateEventId();
      const parts = id.split('_');
      const randomPart = parts[2];
      expect(randomPart.length).toBeGreaterThan(0);
      expect(randomPart.length).toBeLessThanOrEqual(9);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateEventId());
      }
      // Allow for rare timestamp collisions, but most should be unique
      expect(ids.size).toBeGreaterThanOrEqual(95);
    });

    it('should return a string', () => {
      expect(typeof generateEventId()).toBe('string');
    });
  });
});
