/**
 * Google Slides Generation Service (Route A)
 *
 * Creates Google Slides presentations directly via REST API.
 * Parses slide-ready Markdown (# Title → --- separators → sections)
 * and converts to Slides API batch requests.
 *
 * No npm deps — fetch-based, Zod validation.
 */

import { z } from 'zod';
import { CircuitBreaker } from '../utils/circuit-breaker';

// Re-export formatter functions
export {
  formatDigestAsSlideMarkdown,
  formatActionItemsAsSlideMarkdown,
  formatTopicAsSlideMarkdown,
  normalizeMarkdownForSlides,
} from './slide-formatters';

// Re-export builder types and functions
export type { SlideSection, PlaceholderInfo } from './slide-builders';
export {
  parseMarkdownToSections,
  buildBatchRequests,
  appendSlides,
} from './slide-builders';

// ============================================================================
// Schemas
// ============================================================================

const GenerateSlidesOptionsSchema = z.object({
  markdown: z.string().min(1),
  title: z.string().min(1),
  accessToken: z.string().min(1),
  /** Append to existing presentation instead of creating a new one */
  appendTo: z.string().optional(),
  /** Share the created presentation with this email (needed for service account auth) */
  shareWithEmail: z.string().email().optional(),
  /** GCP project ID for quota attribution */
  quotaProject: z.string().optional(),
});

export type GenerateSlidesOptions = z.infer<typeof GenerateSlidesOptionsSchema>;

const GenerateSlidesResultSchema = z.object({
  slidesUrl: z.string().url(),
  slidesId: z.string().min(1),
});

export type GenerateSlidesResult = z.infer<typeof GenerateSlidesResultSchema>;

// ============================================================================
// Constants
// ============================================================================

export const SLIDES_API = 'https://slides.googleapis.com/v1/presentations';
const REQUEST_TIMEOUT = 30_000;

// Circuit breakers for external services
const slidesCircuitBreaker = new CircuitBreaker('GoogleSlidesAPI', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000, // 1 minute
  successThreshold: 2,
});

const driveCircuitBreaker = new CircuitBreaker('GoogleDriveAPI', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  successThreshold: 2,
});

const excalidrawCircuitBreaker = new CircuitBreaker('ExcalidrawAPI', {
  failureThreshold: 3,
  resetTimeoutMs: 30_000, // 30 seconds for local service
  successThreshold: 2,
});

export type AuthHeaders = {
  Authorization: string;
  'x-goog-user-project'?: string;
  'Content-Type'?: string;
};

function buildAuthHeaders(accessToken: string, quotaProject?: string): AuthHeaders {
  const h: AuthHeaders = { Authorization: `Bearer ${accessToken}` };
  if (quotaProject) {
    h['x-goog-user-project'] = quotaProject;
  }
  return h;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate Google Slides from Markdown content via Google Slides REST API.
 *
 * @param options - Markdown content, title, access token, optional appendTo ID
 * @returns URL and ID of the created/appended presentation
 */
export async function generateSlidesFromMarkdown(
  options: GenerateSlidesOptions
): Promise<GenerateSlidesResult> {
  const { markdown, title, accessToken, appendTo, shareWithEmail, quotaProject } = GenerateSlidesOptionsSchema.parse(options);

  // Import the parser from slide-builders
  const { parseMarkdownToSections, buildBatchRequests, appendSlides: appendSlidesImpl } = await import('./slide-builders');

  const sections = parseMarkdownToSections(markdown);
  if (sections.length === 0) {
    throw new Error('No slide sections found in markdown');
  }

  const headers = buildAuthHeaders(accessToken, quotaProject);
  let presentationId: string;

  if (appendTo) {
    presentationId = appendTo;
    // Append: create all sections as new slides
    await appendSlidesImpl(presentationId, headers, sections);
  } else {
    // Create new presentation (comes with one blank title slide)
    presentationId = await createPresentation(title, headers);

    // Get the auto-created first slide's placeholder IDs
    const firstSlidePlaceholders = await getFirstSlidePlaceholders(presentationId, headers);

    // Build batch: populate first slide + create additional slides + populate them
    const requests = buildBatchRequests(sections, firstSlidePlaceholders);
    if (requests.length > 0) {
      await batchUpdate(presentationId, requests, headers);
    }
  }

  // Share with user if using service account auth
  if (shareWithEmail && !appendTo) {
    await sharePresentation(presentationId, headers, shareWithEmail);
  }

  const slidesUrl = `https://docs.google.com/presentation/d/${presentationId}`;

  return GenerateSlidesResultSchema.parse({ slidesUrl, slidesId: presentationId });
}

// ============================================================================
// Google Slides REST API
// ============================================================================

async function createPresentation(title: string, auth: AuthHeaders): Promise<string> {
  return slidesCircuitBreaker.execute(async () => {
    const response = await fetchWithTimeout(`${SLIDES_API}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create presentation (${response.status}): ${errorText.substring(0, 300)}`);
    }

    const data = await response.json() as { presentationId: string };
    return data.presentationId;
  });
}

async function getFirstSlidePlaceholders(
  presentationId: string,
  auth: AuthHeaders
): Promise<{ slideObjectId: string; placeholders: Array<{ objectId: string; type: string }> }> {
  return slidesCircuitBreaker.execute(async () => {
    const response = await fetchWithTimeout(`${SLIDES_API}/${presentationId}`, {
      method: 'GET',
      headers: auth,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get presentation (${response.status}): ${errorText.substring(0, 300)}`);
    }

    const data = await response.json() as {
      slides: Array<{
        objectId: string;
        pageElements?: Array<{
          objectId: string;
          shape?: { placeholder?: { type: string } };
        }>;
      }>;
    };

    const firstSlide = data.slides[0];
    const placeholders = (firstSlide.pageElements || [])
      .filter((el) => el.shape?.placeholder?.type)
      .map((el) => ({
        objectId: el.objectId,
        type: el.shape!.placeholder!.type,
      }));

    return { slideObjectId: firstSlide.objectId, placeholders };
  });
}

export async function batchUpdate(
  presentationId: string,
  requests: unknown[],
  auth: AuthHeaders
): Promise<void> {
  return slidesCircuitBreaker.execute(async () => {
    const response = await fetchWithTimeout(`${SLIDES_API}/${presentationId}:batchUpdate`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Slides batchUpdate failed (${response.status}): ${errorText.substring(0, 300)}`);
    }
  });
}

async function sharePresentation(
  presentationId: string,
  auth: AuthHeaders,
  email: string
): Promise<void> {
  return driveCircuitBreaker.execute(async () => {
    const response = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${presentationId}/permissions`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'user',
          role: 'writer',
          emailAddress: email,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      // Non-fatal: log warning but don't fail
      console.warn(`  Warning: Failed to share presentation with ${email} (${response.status}): ${errorText.substring(0, 200)}`);
    }
  });
}

// ============================================================================
// Excalidraw Integration
// ============================================================================

const EXCALIDRAW_DEFAULT_URL = 'http://localhost:3001';

/**
 * Send a Mermaid diagram to the Excalidraw canvas server for interactive rendering.
 *
 * This is a side-channel call — the diagram is also rendered as a static image
 * via mermaid.ink for Google Slides embedding.  The Excalidraw canvas provides
 * an interactive editing surface.
 *
 * @param mermaidCode - Raw Mermaid definition (e.g. "graph TD\n  A-->B")
 * @param serverUrl   - Excalidraw canvas server URL (default: http://localhost:3001)
 * @returns true if the server accepted the diagram, false on any error
 */
export async function sendMermaidToExcalidraw(
  mermaidCode: string,
  serverUrl: string = EXCALIDRAW_DEFAULT_URL,
): Promise<boolean> {
  try {
    return await excalidrawCircuitBreaker.execute(async () => {
      const response = await fetch(`${serverUrl}/api/elements/from-mermaid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mermaidDiagram: mermaidCode }),
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    });
  } catch {
    // Non-fatal: Excalidraw canvas may not be running
    return false;
  }
}

/**
 * Extract all Mermaid code blocks from raw Markdown.
 */
export function extractMermaidBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

// ============================================================================
// Internal Helpers
// ============================================================================

export async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
