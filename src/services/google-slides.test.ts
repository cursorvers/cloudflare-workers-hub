/**
 * Tests for Google Slides generation service.
 *
 * Covers:
 * - Markdown formatters (digest, action items, topic, normalize)
 * - Markdown → section parsing (via generateSlidesFromMarkdown with mocked API)
 * - Infographic layout detection (stats, icon_grid)
 * - Mermaid block extraction
 * - Excalidraw integration (sendMermaidToExcalidraw)
 * - Zod schema validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WeeklyDigest, ActionItemReport } from './digest-generator';
import {
  formatDigestAsSlideMarkdown,
  formatActionItemsAsSlideMarkdown,
  formatTopicAsSlideMarkdown,
  normalizeMarkdownForSlides,
  extractMermaidBlocks,
  sendMermaidToExcalidraw,
  generateSlidesFromMarkdown,
} from './google-slides';

// ============================================================================
// Test fixtures
// ============================================================================

function createMockDigest(overrides: Partial<WeeklyDigest> = {}): WeeklyDigest {
  return {
    periodStart: '2026-01-20',
    periodEnd: '2026-01-26',
    totalRecordings: 42,
    totalDurationSeconds: 7200,
    classificationBreakdown: { meeting: 10, note: 5 },
    sentimentDistribution: { positive: 20, neutral: 15, negative: 7 },
    topTopics: [
      { topic: 'AI Development', count: 12, classifications: ['meeting'] },
      { topic: 'Product Design', count: 8, classifications: ['meeting'] },
    ],
    allActionItems: ['Deploy v2', 'Review PR #42'],
    allInsights: ['Team velocity increased', 'New tool adoption is high'],
    starredCount: 5,
    dailyStats: [],
    highlights: [
      { title: 'Launch Meeting', classification: 'meeting', summary: 'Discussed Q1 launch plan', time: '2026-01-22T10:00:00Z' },
    ],
    ...overrides,
  };
}

function createMockActionItemReport(overrides: Partial<ActionItemReport> = {}): ActionItemReport {
  return {
    periodStart: '2026-01-20',
    periodEnd: '2026-01-26',
    totalItems: 5,
    itemsByTopic: {
      Engineering: ['Deploy v2', 'Fix bug #123'],
      Design: ['Create mockup', 'Review palette'],
    },
    recentItems: [
      { item: 'Deploy v2', date: '2026-01-25', classification: 'meeting' },
    ],
    ...overrides,
  };
}

// ============================================================================
// formatDigestAsSlideMarkdown
// ============================================================================

describe('formatDigestAsSlideMarkdown', () => {
  it('should produce a title slide with period dates', () => {
    const digest = createMockDigest();
    const result = formatDigestAsSlideMarkdown(digest, 'Weekly Report');

    expect(result).toContain('# Weekly Report');
    expect(result).toContain('2026-01-20');
    expect(result).toContain('2026-01-26');
  });

  it('should include overview stats', () => {
    const digest = createMockDigest();
    const result = formatDigestAsSlideMarkdown(digest, 'Weekly');

    expect(result).toContain('## Overview');
    expect(result).toContain('Recordings: 42');
    expect(result).toContain('Action Items: 2');
  });

  it('should include top topics', () => {
    const digest = createMockDigest();
    const result = formatDigestAsSlideMarkdown(digest, 'Weekly');

    expect(result).toContain('## Top Topics');
    expect(result).toContain('AI Development');
    expect(result).toContain('12x');
  });

  it('should include key insights', () => {
    const digest = createMockDigest();
    const result = formatDigestAsSlideMarkdown(digest, 'Weekly');

    expect(result).toContain('## Key Insights');
    expect(result).toContain('Team velocity increased');
  });

  it('should include action items', () => {
    const digest = createMockDigest();
    const result = formatDigestAsSlideMarkdown(digest, 'Weekly');

    expect(result).toContain('## Action Items');
    expect(result).toContain('Deploy v2');
  });

  it('should include highlights', () => {
    const digest = createMockDigest();
    const result = formatDigestAsSlideMarkdown(digest, 'Weekly');

    expect(result).toContain('## Highlights');
    expect(result).toContain('Launch Meeting');
  });

  it('should include sentiment distribution', () => {
    const digest = createMockDigest();
    const result = formatDigestAsSlideMarkdown(digest, 'Weekly');

    expect(result).toContain('## Sentiment Distribution');
    expect(result).toContain('positive');
  });

  it('should separate sections with ---', () => {
    const digest = createMockDigest();
    const result = formatDigestAsSlideMarkdown(digest, 'Weekly');

    expect(result).toContain('---');
    const sectionCount = result.split('---').length;
    expect(sectionCount).toBeGreaterThanOrEqual(4);
  });

  it('should omit empty sections', () => {
    const digest = createMockDigest({
      topTopics: [],
      allInsights: [],
      allActionItems: [],
      highlights: [],
      sentimentDistribution: {},
    });
    const result = formatDigestAsSlideMarkdown(digest, 'Weekly');

    expect(result).not.toContain('## Top Topics');
    expect(result).not.toContain('## Key Insights');
    expect(result).not.toContain('## Highlights');
    expect(result).not.toContain('## Sentiment Distribution');
  });
});

// ============================================================================
// formatActionItemsAsSlideMarkdown
// ============================================================================

describe('formatActionItemsAsSlideMarkdown', () => {
  it('should produce title and summary slides', () => {
    const report = createMockActionItemReport();
    const result = formatActionItemsAsSlideMarkdown(report, 'Action Items');

    expect(result).toContain('# Action Items');
    expect(result).toContain('## Summary');
    expect(result).toContain('Total Action Items: 5');
    expect(result).toContain('Topic Categories: 2');
  });

  it('should produce per-topic slides', () => {
    const report = createMockActionItemReport();
    const result = formatActionItemsAsSlideMarkdown(report, 'Actions');

    expect(result).toContain('## Engineering');
    expect(result).toContain('Deploy v2');
    expect(result).toContain('## Design');
    expect(result).toContain('Create mockup');
  });

  it('should truncate topics with more than 6 items', () => {
    const report = createMockActionItemReport({
      itemsByTopic: {
        Big: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
      },
    });
    const result = formatActionItemsAsSlideMarkdown(report, 'Actions');

    expect(result).toContain('... and 2 more');
  });

  it('should limit to 5 topic slides', () => {
    const manyTopics: Record<string, string[]> = {};
    for (let i = 0; i < 8; i++) {
      manyTopics[`Topic${i}`] = [`Item${i}`];
    }
    const report = createMockActionItemReport({ itemsByTopic: manyTopics });
    const result = formatActionItemsAsSlideMarkdown(report, 'Actions');

    // Should have title + summary + 5 topics = 7 sections
    const sectionCount = result.split('---').length;
    expect(sectionCount).toBeLessThanOrEqual(7);
  });
});

// ============================================================================
// formatTopicAsSlideMarkdown
// ============================================================================

describe('formatTopicAsSlideMarkdown', () => {
  it('should produce a title slide from topic', () => {
    const result = formatTopicAsSlideMarkdown('AI Trends', 'Content here');

    expect(result).toContain('# AI Trends');
  });

  it('should convert plain paragraphs to bullets', () => {
    const result = formatTopicAsSlideMarkdown('Test', 'First point\n\nSecond point');

    expect(result).toContain('* First point');
    expect(result).toContain('* Second point');
  });

  it('should preserve existing bullet points', () => {
    const result = formatTopicAsSlideMarkdown('Test', '* Already a bullet\n\n- Dash bullet');

    expect(result).toContain('* Already a bullet');
    expect(result).toContain('* Dash bullet');
  });

  it('should start new slide on headings', () => {
    const result = formatTopicAsSlideMarkdown('Test', '## Section A\n\nContent\n\n## Section B\n\nMore');

    expect(result).toContain('## Section A');
    expect(result).toContain('## Section B');
    expect(result).toContain('---');
  });

  it('should split long content into multiple slides (max 6 bullets)', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Point ${i + 1}`).join('\n\n');
    const result = formatTopicAsSlideMarkdown('Test', lines);

    const slideCount = result.split('---').length;
    expect(slideCount).toBeGreaterThanOrEqual(3); // title + at least 2 content slides
  });
});

// ============================================================================
// normalizeMarkdownForSlides
// ============================================================================

describe('normalizeMarkdownForSlides', () => {
  it('should insert --- before new headings', () => {
    const input = '# Title\n\nSome text\n\n## Section 1\n\nContent\n\n## Section 2';
    const result = normalizeMarkdownForSlides(input);

    const parts = result.split('---');
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it('should not double-insert --- between consecutive headings', () => {
    const input = '# Title\n## Subtitle';
    const result = normalizeMarkdownForSlides(input);

    // Second heading follows first, so no separator should be added
    expect(result).not.toContain('---');
  });

  it('should return unchanged if no headings', () => {
    const input = 'Just some plain text\nAnother line';
    const result = normalizeMarkdownForSlides(input);

    expect(result).toBe(input);
  });
});

// ============================================================================
// extractMermaidBlocks
// ============================================================================

describe('extractMermaidBlocks', () => {
  it('should extract single mermaid block', () => {
    const md = 'Some text\n\n```mermaid\ngraph TD\n    A-->B\n```\n\nMore text';
    const blocks = extractMermaidBlocks(md);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('graph TD');
    expect(blocks[0]).toContain('A-->B');
  });

  it('should extract multiple mermaid blocks', () => {
    const md = '```mermaid\ngraph LR\n    A-->B\n```\n\n```mermaid\nsequenceDiagram\n    A->>B: Hello\n```';
    const blocks = extractMermaidBlocks(md);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('graph LR');
    expect(blocks[1]).toContain('sequenceDiagram');
  });

  it('should return empty array when no mermaid blocks', () => {
    const md = '# Title\n\nJust text\n\n```javascript\nconsole.log("hi")\n```';
    const blocks = extractMermaidBlocks(md);

    expect(blocks).toHaveLength(0);
  });

  it('should trim extracted blocks', () => {
    const md = '```mermaid\n  graph TD\n    A-->B  \n```';
    const blocks = extractMermaidBlocks(md);

    expect(blocks[0]).toBe('graph TD\n    A-->B');
  });
});

// ============================================================================
// sendMermaidToExcalidraw
// ============================================================================

describe('sendMermaidToExcalidraw', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return true on successful POST', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
    });

    const result = await sendMermaidToExcalidraw('graph TD\n    A-->B');
    expect(result).toBe(true);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/elements/from-mermaid',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mermaidDiagram: 'graph TD\n    A-->B' }),
      }),
    );
  });

  it('should return false on HTTP error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await sendMermaidToExcalidraw('invalid');
    expect(result).toBe(false);
  });

  it('should return false on network error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Connection refused'),
    );

    const result = await sendMermaidToExcalidraw('graph TD');
    expect(result).toBe(false);
  });

  it('should use custom server URL', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await sendMermaidToExcalidraw('graph TD', 'http://custom:9999');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://custom:9999/api/elements/from-mermaid',
      expect.anything(),
    );
  });
});

// ============================================================================
// generateSlidesFromMarkdown — schema validation
// ============================================================================

describe('generateSlidesFromMarkdown', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should reject empty markdown', async () => {
    await expect(
      generateSlidesFromMarkdown({
        markdown: '',
        title: 'Test',
        accessToken: 'token',
      }),
    ).rejects.toThrow();
  });

  it('should reject empty title', async () => {
    await expect(
      generateSlidesFromMarkdown({
        markdown: '# Slide',
        title: '',
        accessToken: 'token',
      }),
    ).rejects.toThrow();
  });

  it('should reject empty accessToken', async () => {
    await expect(
      generateSlidesFromMarkdown({
        markdown: '# Slide',
        title: 'Test',
        accessToken: '',
      }),
    ).rejects.toThrow();
  });

  it('should create presentation and return URL on success', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    // 1. createPresentation POST
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ presentationId: 'pres_123' }),
    });
    // 2. getFirstSlidePlaceholders GET
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        slides: [{
          objectId: 'slide0',
          pageElements: [
            { objectId: 'title0', shape: { placeholder: { type: 'CENTERED_TITLE' } } },
            { objectId: 'subtitle0', shape: { placeholder: { type: 'SUBTITLE' } } },
          ],
        }],
      }),
    });
    // 3. batchUpdate POST
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ replies: [] }),
    });

    const result = await generateSlidesFromMarkdown({
      markdown: '# Test Title\n\nSubtitle text\n\n---\n\n## Section 1\n\n* Point A\n* Point B',
      title: 'Test Presentation',
      accessToken: 'fake-token',
    });

    expect(result.slidesId).toBe('pres_123');
    expect(result.slidesUrl).toBe('https://docs.google.com/presentation/d/pres_123');
  });

  it('should handle append mode', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    // 1. appendSlides → GET current presentation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ slides: [{ objectId: 'existing_slide' }] }),
    });
    // 2. batchUpdate POST
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ replies: [] }),
    });

    const result = await generateSlidesFromMarkdown({
      markdown: '## New Section\n\n* Point A',
      title: 'Append Test',
      accessToken: 'fake-token',
      appendTo: 'existing_pres_456',
    });

    expect(result.slidesId).toBe('existing_pres_456');
    expect(result.slidesUrl).toContain('existing_pres_456');
  });

  it('should throw on API error during createPresentation', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(
      generateSlidesFromMarkdown({
        markdown: '# Test',
        title: 'Fail',
        accessToken: 'bad-token',
      }),
    ).rejects.toThrow(/Failed to create presentation/);
  });
});

// ============================================================================
// Infographic layout detection (indirect via generateSlidesFromMarkdown)
// ============================================================================

describe('Infographic layout detection', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setupMockSlideCreation() {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    // createPresentation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ presentationId: 'infographic_test' }),
    });
    // getFirstSlidePlaceholders
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        slides: [{
          objectId: 'slide0',
          pageElements: [
            { objectId: 'title0', shape: { placeholder: { type: 'CENTERED_TITLE' } } },
          ],
        }],
      }),
    });
    // batchUpdate
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ replies: [] }),
    });
    return mockFetch;
  }

  it('should detect stats layout from emoji+value|label pattern', async () => {
    const mockFetch = setupMockSlideCreation();

    const md = [
      '# Dashboard',
      '',
      '---',
      '',
      '## Key Metrics',
      '<!-- stats -->',
      '\uD83E\uDD16 5 | AI Agents',
      '\uD83D\uDCCA 3 | Data Pipelines',
      '\u26A1 24/7 | Uptime',
    ].join('\n');

    await generateSlidesFromMarkdown({
      markdown: md,
      title: 'Stats Test',
      accessToken: 'token',
    });

    // Verify batchUpdate was called (3rd call)
    const batchCall = mockFetch.mock.calls[2];
    expect(batchCall).toBeDefined();

    // Parse the body to check that BLANK layout is used (stats use BLANK, not TITLE_AND_BODY)
    const body = JSON.parse(batchCall[1].body) as { requests: Array<{ createSlide?: { slideLayoutReference?: { predefinedLayout: string } } }> };
    const slideCreates = body.requests.filter(
      (r: Record<string, unknown>) => r.createSlide,
    );

    // At least one BLANK slide (the stats slide) plus any other slides
    const blankSlides = slideCreates.filter(
      (r: Record<string, unknown>) => {
        const cs = r.createSlide as { slideLayoutReference?: { predefinedLayout: string } };
        return cs.slideLayoutReference?.predefinedLayout === 'BLANK';
      },
    );
    expect(blankSlides.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect icon_grid layout from emoji+text lines with hint', async () => {
    const mockFetch = setupMockSlideCreation();

    const md = [
      '# Tech',
      '',
      '---',
      '',
      '## Core Capabilities',
      '<!-- icons -->',
      '\uD83E\uDDE0 Intelligent Routing',
      '\uD83D\uDD04 Auto Delegation',
      '\uD83D\uDCC8 Real-time Processing',
    ].join('\n');

    await generateSlidesFromMarkdown({
      markdown: md,
      title: 'Icons Test',
      accessToken: 'token',
    });

    const batchCall = mockFetch.mock.calls[2];
    const body = JSON.parse(batchCall[1].body) as { requests: Array<{ createShape?: { shapeType?: string } }> };

    // Icon grid creates ELLIPSE shapes for circles
    const ellipseShapes = body.requests.filter(
      (r: Record<string, unknown>) => {
        const cs = r.createShape as { shapeType?: string } | undefined;
        return cs?.shapeType === 'ELLIPSE';
      },
    );
    expect(ellipseShapes.length).toBeGreaterThanOrEqual(3);
  });

  it('should detect mermaid diagram and produce image_only layout', async () => {
    const mockFetch = setupMockSlideCreation();

    const md = [
      '# Architecture',
      '',
      '---',
      '',
      '## System',
      '',
      '```mermaid',
      'graph TD',
      '    A-->B',
      '```',
    ].join('\n');

    await generateSlidesFromMarkdown({
      markdown: md,
      title: 'Mermaid Test',
      accessToken: 'token',
    });

    const batchCall = mockFetch.mock.calls[2];
    const body = JSON.parse(batchCall[1].body) as { requests: Array<{ createImage?: { url?: string } }> };

    // Should contain a createImage request with mermaid.ink URL
    const imageReqs = body.requests.filter(
      (r: Record<string, unknown>) => r.createImage,
    );
    expect(imageReqs.length).toBeGreaterThanOrEqual(1);

    const imgUrl = (imageReqs[0].createImage as { url: string }).url;
    expect(imgUrl).toContain('mermaid.ink/img/');
  });
});

// ============================================================================
// Append mode with infographic layouts
// ============================================================================

describe('appendSlides with infographic layouts', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should create BLANK slides for stats layout in append mode', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    // GET presentation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ slides: [{ objectId: 'existing' }] }),
    });
    // batchUpdate
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ replies: [] }),
    });

    const md = [
      '## Metrics',
      '<!-- stats -->',
      '\uD83E\uDD16 5 | Agents',
      '\uD83D\uDCCA 3 | Pipelines',
      '\u26A1 24/7 | Uptime',
    ].join('\n');

    await generateSlidesFromMarkdown({
      markdown: md,
      title: 'Append Stats',
      accessToken: 'token',
      appendTo: 'existing_pres',
    });

    // Check batchUpdate (2nd call)
    const batchCall = mockFetch.mock.calls[1];
    const body = JSON.parse(batchCall[1].body) as { requests: Array<{ createSlide?: { slideLayoutReference?: { predefinedLayout: string } }; createShape?: { shapeType?: string } }> };

    // Should use BLANK layout (stats slide)
    const slideCreates = body.requests.filter(
      (r: Record<string, unknown>) => r.createSlide,
    );
    expect(slideCreates.length).toBeGreaterThanOrEqual(1);
    const firstCreate = slideCreates[0].createSlide as { slideLayoutReference?: { predefinedLayout: string } };
    expect(firstCreate.slideLayoutReference?.predefinedLayout).toBe('BLANK');

    // Should have ROUND_RECTANGLE shapes (stat cards)
    const roundRects = body.requests.filter(
      (r: Record<string, unknown>) => {
        const cs = r.createShape as { shapeType?: string } | undefined;
        return cs?.shapeType === 'ROUND_RECTANGLE';
      },
    );
    expect(roundRects.length).toBeGreaterThanOrEqual(3);
  });

  it('should create ELLIPSE shapes for icon_grid in append mode', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    // GET presentation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ slides: [{ objectId: 'existing' }] }),
    });
    // batchUpdate
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ replies: [] }),
    });

    const md = [
      '## Features',
      '<!-- icons -->',
      '\uD83E\uDDE0 Intelligence',
      '\uD83D\uDD04 Automation',
      '\uD83D\uDCC8 Analytics',
    ].join('\n');

    await generateSlidesFromMarkdown({
      markdown: md,
      title: 'Append Icons',
      accessToken: 'token',
      appendTo: 'existing_pres',
    });

    const batchCall = mockFetch.mock.calls[1];
    const body = JSON.parse(batchCall[1].body) as { requests: Array<{ createShape?: { shapeType?: string } }> };

    const ellipses = body.requests.filter(
      (r: Record<string, unknown>) => {
        const cs = r.createShape as { shapeType?: string } | undefined;
        return cs?.shapeType === 'ELLIPSE';
      },
    );
    expect(ellipses.length).toBeGreaterThanOrEqual(3);
  });
});
