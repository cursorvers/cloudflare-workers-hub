/**
 * NotebookLM Enterprise API Service (Route B)
 *
 * Creates notebooks and adds sources via the Discovery Engine REST API.
 * Generates slide decks via `notebooklm-py` CLI (no REST endpoint yet).
 *
 * API: https://{location}-discoveryengine.googleapis.com/v1alpha/
 *       projects/{projectNumber}/locations/{location}/
 *       notebookLmApps/{appId}/notebooks
 *
 * No npm deps — fetch-based, Zod validation.
 */

import { z } from 'zod';

// ============================================================================
// Schemas
// ============================================================================

const NotebookLMConfigSchema = z.object({
  projectNumber: z.string().min(1, 'GCP project number is required'),
  location: z.string().min(1).default('us'),
  appId: z.string().min(1).default('default'),
});

export type NotebookLMConfig = z.infer<typeof NotebookLMConfigSchema>;

const NotebookSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    title: z.string().min(1),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal('url'),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal('googleSlides'),
    resourceId: z.string().min(1, 'Google Slides ID is required'),
  }),
]);

export type NotebookSource = z.infer<typeof NotebookSourceSchema>;

const CreateNotebookResponseSchema = z.object({
  name: z.string().min(1),
});

const AddSourceResponseSchema = z.object({
  name: z.string().min(1),
});

const SlideDeckResultSchema = z.object({
  pdfPath: z.string().optional(),
  notebookUrl: z.string().optional(),
});

export type SlideDeckResult = z.infer<typeof SlideDeckResultSchema>;

// ============================================================================
// Constants
// ============================================================================

const NOTEBOOKLM_PY_BIN = 'notebooklm';
const REQUEST_TIMEOUT = 30_000;

// ============================================================================
// Public API — REST
// ============================================================================

/**
 * Create a new notebook in NotebookLM Enterprise.
 *
 * @param config - NotebookLM project config
 * @param accessToken - Google OAuth access token
 * @param title - Notebook title
 * @returns Full resource name of created notebook
 */
export async function createNotebook(
  config: NotebookLMConfig,
  accessToken: string,
  title: string
): Promise<string> {
  const validated = NotebookLMConfigSchema.parse(config);
  const baseUrl = buildBaseUrl(validated);

  const response = await fetchWithTimeout(`${baseUrl}/notebooks`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create notebook (${response.status}): ${errorText.substring(0, 300)}`
    );
  }

  const data = await response.json();
  const { name } = CreateNotebookResponseSchema.parse(data);
  return name;
}

/**
 * Add sources to an existing notebook.
 *
 * @param config - NotebookLM project config
 * @param accessToken - Google OAuth access token
 * @param notebookName - Full resource name of the notebook
 * @param sources - Array of sources to add
 * @returns Array of source resource names
 */
export async function addSources(
  config: NotebookLMConfig,
  accessToken: string,
  notebookName: string,
  sources: NotebookSource[]
): Promise<string[]> {
  const validated = NotebookLMConfigSchema.parse(config);
  const results: string[] = [];

  for (const source of sources) {
    const validatedSource = NotebookSourceSchema.parse(source);
    const sourceBody = buildSourceBody(validatedSource);

    const response = await fetchWithTimeout(
      `https://${validated.location}-discoveryengine.googleapis.com/v1alpha/${notebookName}/sources`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sourceBody),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to add source (${response.status}): ${errorText.substring(0, 300)}`
      );
    }

    const data = await response.json();
    const { name } = AddSourceResponseSchema.parse(data);
    results.push(name);
  }

  return results;
}

// ============================================================================
// Public API — CLI wrapper (notebooklm-py)
// ============================================================================

/**
 * Generate a slide deck from an existing notebook.
 *
 * Uses `notebooklm-py` CLI because the Enterprise API does not yet
 * expose a slide-deck generation endpoint.
 *
 * Prerequisite: `pip install "notebooklm-py[browser]" && playwright install chromium`
 *
 * @param notebookUrl - Full URL of the notebook
 * @returns Slide deck result (PDF path if downloaded)
 */
export async function generateSlideDeck(
  notebookUrl: string
): Promise<SlideDeckResult> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const { stdout, stderr } = await execFileAsync(
      NOTEBOOKLM_PY_BIN,
      ['generate', 'slide-deck', '--url', notebookUrl],
      { timeout: 120_000 }
    );

    const output = stdout + '\n' + stderr;

    // notebooklm-py typically prints the notebook URL or status
    return SlideDeckResultSchema.parse({
      notebookUrl,
      pdfPath: undefined,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'notebooklm-py not found. Install with: pip install "notebooklm-py[browser]" && playwright install chromium'
      );
    }
    throw new Error(`notebooklm-py slide-deck generation failed: ${String(error)}`);
  }
}

/**
 * Download a generated slide deck as PDF.
 *
 * @param notebookUrl - Full URL of the notebook
 * @param outputPath - Local file path for the PDF
 * @returns Path to the downloaded PDF
 */
export async function downloadSlideDeck(
  notebookUrl: string,
  outputPath: string
): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    await execFileAsync(
      NOTEBOOKLM_PY_BIN,
      ['download', 'slide-deck', '--url', notebookUrl, '--output', outputPath],
      { timeout: 120_000 }
    );

    return outputPath;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'notebooklm-py not found. Install with: pip install "notebooklm-py[browser]" && playwright install chromium'
      );
    }
    throw new Error(`notebooklm-py download failed: ${String(error)}`);
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

function buildBaseUrl(config: NotebookLMConfig): string {
  return (
    `https://${config.location}-discoveryengine.googleapis.com/v1alpha/` +
    `projects/${config.projectNumber}/locations/${config.location}/` +
    `notebookLmApps/${config.appId}`
  );
}

function buildSourceBody(source: NotebookSource): Record<string, unknown> {
  switch (source.type) {
    case 'text':
      return {
        inlineSource: {
          title: source.title,
          content: source.content,
        },
      };
    case 'url':
      return {
        urlSource: {
          url: source.url,
        },
      };
    case 'googleSlides':
      return {
        driveSource: {
          resourceId: source.resourceId,
        },
      };
  }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}
