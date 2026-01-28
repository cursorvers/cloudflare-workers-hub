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
import type { WeeklyDigest, ActionItemReport } from './digest-generator';

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
// Types (internal)
// ============================================================================

interface SlideSection {
  heading: string;
  body: string[];
  isTitle: boolean;
  subtitle?: string;
}

interface PlaceholderInfo {
  objectId: string;
  type: string;
}

// ============================================================================
// Constants
// ============================================================================

const SLIDES_API = 'https://slides.googleapis.com/v1/presentations';
const REQUEST_TIMEOUT = 30_000;

interface AuthHeaders {
  Authorization: string;
  'x-goog-user-project'?: string;
}

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

  const sections = parseMarkdownToSections(markdown);
  if (sections.length === 0) {
    throw new Error('No slide sections found in markdown');
  }

  const headers = buildAuthHeaders(accessToken, quotaProject);
  let presentationId: string;

  if (appendTo) {
    presentationId = appendTo;
    // Append: create all sections as new slides
    await appendSlides(presentationId, headers, sections);
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
// Markdown Formatters (Digest → Slide Markdown)
// ============================================================================

/**
 * Format a WeeklyDigest into slide-ready Markdown.
 *
 * Format:
 * - `# Title` → Title slide
 * - `---` → New slide separator
 * - `## Heading` → Section header on slide
 * - Bullet lists → Slide body bullets
 */
export function formatDigestAsSlideMarkdown(
  digest: WeeklyDigest,
  title: string
): string {
  const sections: string[] = [];

  // Title slide
  sections.push(`# ${title}\n\n${digest.periodStart} ~ ${digest.periodEnd}`);

  // Overview slide
  const overviewLines: string[] = [
    '## Overview',
    '',
    `* Recordings: ${digest.totalRecordings}`,
    `* Total Duration: ${formatDurationCompact(digest.totalDurationSeconds)}`,
    `* Starred: ${digest.starredCount}`,
    `* Action Items: ${digest.allActionItems.length}`,
  ];
  const topClassifications = Object.entries(digest.classificationBreakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([cls, count]) => `${cls}: ${count}`);
  if (topClassifications.length > 0) {
    overviewLines.push(`* Types: ${topClassifications.join(', ')}`);
  }
  sections.push(overviewLines.join('\n'));

  // Top Topics slide
  if (digest.topTopics.length > 0) {
    const topicLines = ['## Top Topics', ''];
    for (const t of digest.topTopics.slice(0, 8)) {
      topicLines.push(`* **${t.topic}** (${t.count}x)`);
    }
    sections.push(topicLines.join('\n'));
  }

  // Key Insights slide
  if (digest.allInsights.length > 0) {
    const insightLines = ['## Key Insights', ''];
    for (const insight of digest.allInsights.slice(0, 6)) {
      insightLines.push(`* ${insight}`);
    }
    sections.push(insightLines.join('\n'));
  }

  // Action Items slide
  if (digest.allActionItems.length > 0) {
    const actionLines = ['## Action Items', ''];
    for (const item of digest.allActionItems.slice(0, 8)) {
      actionLines.push(`* ${item}`);
    }
    sections.push(actionLines.join('\n'));
  }

  // Highlights slide(s)
  if (digest.highlights.length > 0) {
    const highlightLines = ['## Highlights', ''];
    for (const h of digest.highlights.slice(0, 5)) {
      highlightLines.push(`* **${h.title}** (${h.classification})`);
      highlightLines.push(`  ${h.summary.substring(0, 80)}`);
    }
    sections.push(highlightLines.join('\n'));
  }

  // Sentiment slide
  const sentimentEntries = Object.entries(digest.sentimentDistribution)
    .filter(([, count]) => count > 0);
  if (sentimentEntries.length > 0) {
    const sentLines = ['## Sentiment Distribution', ''];
    for (const [sentiment, count] of sentimentEntries) {
      const pct = Math.round((count / digest.totalRecordings) * 100);
      sentLines.push(`* ${sentiment}: ${pct}% (${count})`);
    }
    sections.push(sentLines.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Format an ActionItemReport into slide-ready Markdown.
 */
export function formatActionItemsAsSlideMarkdown(
  report: ActionItemReport,
  title: string
): string {
  const sections: string[] = [];

  // Title slide
  sections.push(`# ${title}\n\n${report.periodStart} ~ ${report.periodEnd}`);

  // Summary slide
  sections.push(
    [
      '## Summary',
      '',
      `* Total Action Items: ${report.totalItems}`,
      `* Topic Categories: ${Object.keys(report.itemsByTopic).length}`,
    ].join('\n')
  );

  // Per-topic slides (max 5 topics)
  const sortedTopics = Object.entries(report.itemsByTopic)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 5);

  for (const [topic, items] of sortedTopics) {
    const topicLines = [`## ${topic}`, ''];
    for (const item of items.slice(0, 6)) {
      topicLines.push(`* ${item}`);
    }
    if (items.length > 6) {
      topicLines.push(`* ... and ${items.length - 6} more`);
    }
    sections.push(topicLines.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Format a free-form topic with content into slide-ready Markdown.
 */
export function formatTopicAsSlideMarkdown(
  topic: string,
  content: string
): string {
  const sections: string[] = [];

  // Title slide
  sections.push(`# ${topic}`);

  // Split content into sections by headings or paragraphs
  const paragraphs = content.split(/\n{2,}/).filter((p) => p.trim().length > 0);

  // Group paragraphs into slides (max ~6 bullets per slide)
  let currentSlide: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();

    // If it looks like a heading, start a new slide
    if (trimmed.startsWith('#')) {
      if (currentSlide.length > 0) {
        sections.push(currentSlide.join('\n'));
        currentSlide = [];
      }
      currentSlide.push(trimmed.replace(/^#+\s*/, '## '));
      currentSlide.push('');
      continue;
    }

    // Convert to bullet point if not already
    const bullet = trimmed.startsWith('*') || trimmed.startsWith('-')
      ? trimmed.replace(/^-/, '*')
      : `* ${trimmed}`;

    currentSlide.push(bullet);

    // Start new slide if current one is getting long
    if (currentSlide.filter((l) => l.startsWith('*')).length >= 6) {
      sections.push(currentSlide.join('\n'));
      currentSlide = [];
    }
  }

  if (currentSlide.length > 0) {
    sections.push(currentSlide.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Format a raw Markdown file's content into slide-compatible format.
 * Ensures proper `---` slide separators between top-level headings.
 */
export function normalizeMarkdownForSlides(rawMarkdown: string): string {
  const lines = rawMarkdown.split('\n');
  const result: string[] = [];
  let lastWasHeading = false;

  for (const line of lines) {
    const isTopHeading = /^#{1,2}\s/.test(line);

    if (isTopHeading && result.length > 0 && !lastWasHeading) {
      // Insert slide separator before new heading
      result.push('');
      result.push('---');
      result.push('');
    }

    result.push(line);
    lastWasHeading = isTopHeading;
  }

  return result.join('\n');
}

// ============================================================================
// Markdown Parser
// ============================================================================

/**
 * Parse slide-ready Markdown into structured sections.
 * Sections are separated by `---`.
 * First section with `# Title` becomes the title slide.
 */
function parseMarkdownToSections(markdown: string): SlideSection[] {
  const rawSections = markdown.split(/\n---\n/).map((s) => s.trim()).filter(Boolean);
  const sections: SlideSection[] = [];

  for (let i = 0; i < rawSections.length; i++) {
    const lines = rawSections[i].split('\n');
    const headingLine = lines.find((l) => /^#{1,2}\s/.test(l));
    const heading = headingLine?.replace(/^#{1,2}\s*/, '') || '';

    const bulletLines = lines
      .filter((l) => /^\*\s/.test(l.trim()))
      .map((l) => l.trim().replace(/^\*\s*/, ''));

    const textLines = lines
      .filter((l) => !l.startsWith('#') && !l.trim().startsWith('*') && l.trim())
      .map((l) => l.trim());

    if (i === 0 && headingLine?.startsWith('# ')) {
      sections.push({
        heading,
        body: [],
        isTitle: true,
        subtitle: textLines.join(' ') || undefined,
      });
    } else {
      sections.push({
        heading,
        body: bulletLines.length > 0 ? bulletLines : textLines,
        isTitle: false,
      });
    }
  }

  return sections;
}

// ============================================================================
// Google Slides REST API
// ============================================================================

async function createPresentation(title: string, auth: AuthHeaders): Promise<string> {
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
}

async function getFirstSlidePlaceholders(
  presentationId: string,
  auth: AuthHeaders
): Promise<{ slideObjectId: string; placeholders: PlaceholderInfo[] }> {
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
  const placeholders: PlaceholderInfo[] = (firstSlide.pageElements || [])
    .filter((el) => el.shape?.placeholder?.type)
    .map((el) => ({
      objectId: el.objectId,
      type: el.shape!.placeholder!.type,
    }));

  return { slideObjectId: firstSlide.objectId, placeholders };
}

async function batchUpdate(
  presentationId: string,
  requests: unknown[],
  auth: AuthHeaders
): Promise<void> {
  const response = await fetchWithTimeout(`${SLIDES_API}/${presentationId}:batchUpdate`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Slides batchUpdate failed (${response.status}): ${errorText.substring(0, 300)}`);
  }
}

async function sharePresentation(
  presentationId: string,
  auth: AuthHeaders,
  email: string
): Promise<void> {
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
}

// ============================================================================
// Batch Request Builders
// ============================================================================

function buildBatchRequests(
  sections: SlideSection[],
  firstSlidePlaceholders: { slideObjectId: string; placeholders: PlaceholderInfo[] }
): unknown[] {
  const requests: unknown[] = [];

  // 1. Populate the auto-created title slide (section 0)
  if (sections.length > 0 && sections[0].isTitle) {
    const titleSection = sections[0];
    const titlePlaceholder = firstSlidePlaceholders.placeholders.find(
      (p) => p.type === 'CENTERED_TITLE' || p.type === 'TITLE'
    );
    const subtitlePlaceholder = firstSlidePlaceholders.placeholders.find(
      (p) => p.type === 'SUBTITLE'
    );

    if (titlePlaceholder && titleSection.heading) {
      requests.push({
        insertText: {
          objectId: titlePlaceholder.objectId,
          text: titleSection.heading,
          insertionIndex: 0,
        },
      });
    }
    if (subtitlePlaceholder && titleSection.subtitle) {
      requests.push({
        insertText: {
          objectId: subtitlePlaceholder.objectId,
          text: titleSection.subtitle,
          insertionIndex: 0,
        },
      });
    }
  }

  // 2. Create additional slides with known placeholder IDs
  const startIndex = sections[0]?.isTitle ? 1 : 0;

  for (let i = startIndex; i < sections.length; i++) {
    const section = sections[i];
    const slideId = `slide_${i}`;
    const titleId = `slide_${i}_title`;
    const bodyId = `slide_${i}_body`;

    // Create slide with TITLE_AND_BODY layout
    requests.push({
      createSlide: {
        objectId: slideId,
        insertionIndex: i,
        slideLayoutReference: {
          predefinedLayout: 'TITLE_AND_BODY',
        },
        placeholderIdMappings: [
          {
            layoutPlaceholder: { type: 'TITLE', index: 0 },
            objectId: titleId,
          },
          {
            layoutPlaceholder: { type: 'BODY', index: 0 },
            objectId: bodyId,
          },
        ],
      },
    });

    // Insert heading text
    if (section.heading) {
      requests.push({
        insertText: {
          objectId: titleId,
          text: section.heading,
          insertionIndex: 0,
        },
      });
    }

    // Insert body bullets
    if (section.body.length > 0) {
      // Strip markdown bold markers for plain text slides
      const bodyText = section.body
        .map((b) => b.replace(/\*\*/g, ''))
        .join('\n');
      requests.push({
        insertText: {
          objectId: bodyId,
          text: bodyText,
          insertionIndex: 0,
        },
      });

      // Make body text bulleted
      requests.push({
        createParagraphBullets: {
          objectId: bodyId,
          textRange: { type: 'ALL' },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    }
  }

  return requests;
}

async function appendSlides(
  presentationId: string,
  auth: AuthHeaders,
  sections: SlideSection[]
): Promise<void> {
  // Get current slide count for insertion index
  const response = await fetchWithTimeout(`${SLIDES_API}/${presentationId}`, {
    method: 'GET',
    headers: auth,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get presentation (${response.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await response.json() as { slides: unknown[] };
  const baseIndex = data.slides.length;
  const ts = Date.now();

  const requests: unknown[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const slideId = `append_${ts}_${i}`;
    const titleId = `append_${ts}_${i}_title`;
    const bodyId = `append_${ts}_${i}_body`;

    const layout = section.isTitle ? 'TITLE' : 'TITLE_AND_BODY';
    const mappings = section.isTitle
      ? [
          { layoutPlaceholder: { type: 'CENTERED_TITLE', index: 0 }, objectId: titleId },
        ]
      : [
          { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId },
          { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: bodyId },
        ];

    requests.push({
      createSlide: {
        objectId: slideId,
        insertionIndex: baseIndex + i,
        slideLayoutReference: { predefinedLayout: layout },
        placeholderIdMappings: mappings,
      },
    });

    if (section.heading) {
      requests.push({
        insertText: { objectId: titleId, text: section.heading, insertionIndex: 0 },
      });
    }

    if (!section.isTitle && section.body.length > 0) {
      const bodyText = section.body.map((b) => b.replace(/\*\*/g, '')).join('\n');
      requests.push({
        insertText: { objectId: bodyId, text: bodyText, insertionIndex: 0 },
      });
      requests.push({
        createParagraphBullets: {
          objectId: bodyId,
          textRange: { type: 'ALL' },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    }
  }

  if (requests.length > 0) {
    await batchUpdate(presentationId, requests, auth);
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

function formatDurationCompact(seconds: number): string {
  if (seconds <= 0) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
