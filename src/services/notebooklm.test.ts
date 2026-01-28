/**
 * Tests for NotebookLM Enterprise API service.
 *
 * Covers:
 * - createNotebook (REST API)
 * - addSources (REST API) with text, url, googleSlides source types
 * - generateSlideDeck (CLI wrapper)
 * - downloadSlideDeck (CLI wrapper)
 * - Zod schema validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createNotebook,
  addSources,
  generateSlideDeck,
  downloadSlideDeck,
} from './notebooklm';
import type { NotebookLMConfig, NotebookSource } from './notebooklm';

// ============================================================================
// Fixtures
// ============================================================================

const MOCK_CONFIG: NotebookLMConfig = {
  projectNumber: '123456789',
  location: 'us',
};

const TOKEN = 'test-access-token';

// ============================================================================
// createNotebook
// ============================================================================

describe('createNotebook', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should create a notebook and return resource name', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        name: 'projects/123456789/locations/us/notebooks/nb_abc',
        notebookId: 'nb_abc',
      }),
    });

    const result = await createNotebook(MOCK_CONFIG, TOKEN, 'Test Notebook');

    expect(result).toBe('projects/123456789/locations/us/notebooks/nb_abc');

    const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('us-discoveryengine.googleapis.com');
    expect(url).toContain('123456789');
    expect(url).toContain('/notebooks');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer test-access-token');
    expect(JSON.parse(options.body)).toEqual({ title: 'Test Notebook' });
  });

  it('should throw on API error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Permission denied',
    });

    await expect(
      createNotebook(MOCK_CONFIG, TOKEN, 'Fail'),
    ).rejects.toThrow(/Failed to create notebook/);
  });

  it('should validate config schema', async () => {
    await expect(
      createNotebook({ projectNumber: '', location: 'us' }, TOKEN, 'Bad'),
    ).rejects.toThrow();
  });
});

// ============================================================================
// addSources
// ============================================================================

describe('addSources', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should add text sources', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sources: [
          { name: 'projects/123/locations/us/notebooks/nb/sources/src_1', title: 'My Doc' },
        ],
      }),
    });

    const sources: NotebookSource[] = [
      { type: 'text', title: 'My Doc', content: 'Some content here' },
    ];

    const result = await addSources(
      MOCK_CONFIG,
      TOKEN,
      'projects/123/locations/us/notebooks/nb',
      sources,
    );

    expect(result).toEqual(['projects/123/locations/us/notebooks/nb/sources/src_1']);

    const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('sources:batchCreate');
    const body = JSON.parse(options.body);
    expect(body.userContents).toHaveLength(1);
    expect(body.userContents[0]).toHaveProperty('textContent');
    expect(body.userContents[0].textContent.content).toBe('Some content here');
  });

  it('should add URL sources', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sources: [
          { name: 'projects/123/locations/us/notebooks/nb/sources/src_2' },
        ],
      }),
    });

    const sources: NotebookSource[] = [
      { type: 'url', url: 'https://example.com/article' },
    ];

    const result = await addSources(
      MOCK_CONFIG,
      TOKEN,
      'projects/123/locations/us/notebooks/nb',
      sources,
    );

    expect(result).toHaveLength(1);

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.userContents[0]).toHaveProperty('webContent');
    expect(body.userContents[0].webContent.url).toBe('https://example.com/article');
  });

  it('should add Google Slides sources', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sources: [
          { name: 'projects/123/locations/us/notebooks/nb/sources/src_3' },
        ],
      }),
    });

    const sources: NotebookSource[] = [
      { type: 'googleSlides', resourceId: 'slides_pres_id_xyz' },
    ];

    await addSources(
      MOCK_CONFIG,
      TOKEN,
      'projects/123/locations/us/notebooks/nb',
      sources,
    );

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.userContents[0]).toHaveProperty('googleDriveContent');
    expect(body.userContents[0].googleDriveContent.documentId).toBe('slides_pres_id_xyz');
    expect(body.userContents[0].googleDriveContent.mimeType).toBe(
      'application/vnd.google-apps.presentation',
    );
  });

  it('should add multiple sources in one call', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sources: [
          { name: 'src_a' },
          { name: 'src_b' },
        ],
      }),
    });

    const sources: NotebookSource[] = [
      { type: 'text', title: 'Doc A', content: 'Content A' },
      { type: 'url', url: 'https://example.com/b' },
    ];

    const result = await addSources(
      MOCK_CONFIG,
      TOKEN,
      'projects/123/locations/us/notebooks/nb',
      sources,
    );

    expect(result).toEqual(['src_a', 'src_b']);
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.userContents).toHaveLength(2);
  });

  it('should throw on API error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad request',
    });

    await expect(
      addSources(MOCK_CONFIG, TOKEN, 'projects/123/notebooks/nb', [
        { type: 'text', title: 'T', content: 'C' },
      ]),
    ).rejects.toThrow(/Failed to add sources/);
  });

  it('should validate source schema', async () => {
    await expect(
      addSources(MOCK_CONFIG, TOKEN, 'nb', [
        // @ts-expect-error intentionally invalid source type
        { type: 'invalid', data: 'bad' },
      ]),
    ).rejects.toThrow();
  });
});

// ============================================================================
// generateSlideDeck (CLI wrapper)
// ============================================================================

describe('generateSlideDeck', () => {
  it('should throw meaningful error when notebooklm-py not installed', async () => {
    // notebooklm-py is not installed in test environment
    await expect(
      generateSlideDeck('https://notebooklm.google.com/notebook/test'),
    ).rejects.toThrow(/notebooklm-py not found|notebooklm-py slide-deck generation failed/);
  });
});

// ============================================================================
// downloadSlideDeck (CLI wrapper)
// ============================================================================

describe('downloadSlideDeck', () => {
  it('should throw meaningful error when notebooklm-py not installed', async () => {
    await expect(
      downloadSlideDeck('https://notebooklm.google.com/notebook/test', '/tmp/output.pdf'),
    ).rejects.toThrow(/notebooklm-py not found|notebooklm-py download failed/);
  });
});
