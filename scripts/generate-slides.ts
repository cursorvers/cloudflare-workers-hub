#!/usr/bin/env npx tsx
/**
 * Google Slides / NotebookLM Unified Generator
 *
 * Route A: Markdown → Google Slides (via REST API)
 * Route B: Source → NotebookLM Enterprise → Slide Deck (PDF)
 * Route both: A → B (create Slides, then feed into NotebookLM)
 *
 * Usage:
 *   # Route A: from file
 *   npx tsx scripts/generate-slides.ts --route a --file slides.md --title "My Talk"
 *
 *   # Route A: from topic
 *   npx tsx scripts/generate-slides.ts --route a --topic "AI Trends 2026"
 *
 *   # Route A: from Supabase digest
 *   npx tsx scripts/generate-slides.ts --route a --source supabase --digest weekly
 *
 *   # Route B: from topic
 *   npx tsx scripts/generate-slides.ts --route b --topic "Market Analysis"
 *
 *   # Both: A then B
 *   npx tsx scripts/generate-slides.ts --route both --file slides.md --title "My Talk"
 *
 *   # Dry run (shows generated Markdown, no API calls)
 *   npx tsx scripts/generate-slides.ts --dry-run --route a --topic "Test"
 *
 * Environment variables:
 *   SUPABASE_URL              - Supabase project URL (for --source supabase)
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service role key
 *   GCP_PROJECT_ID            - GCP project ID (for Route B)
 *   GOOGLE_CREDENTIALS_PATH   - Path to Google credentials JSON (optional)
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const isDryRun = hasFlag('--dry-run');
const routeRaw = getArg('--route') || 'a';
const VALID_ROUTES = ['a', 'b', 'both'] as const;
if (!VALID_ROUTES.includes(routeRaw as typeof VALID_ROUTES[number])) {
  console.error(`Invalid route: "${routeRaw}". Use: a, b, or both`);
  process.exit(1);
}
const route = routeRaw as 'a' | 'b' | 'both';
const inputFile = getArg('--file');
const topic = getArg('--topic');
const title = getArg('--title');
const source = getArg('--source'); // 'supabase' | null
const VALID_DIGEST_TYPES = ['weekly', 'monthly', 'annual', 'actions'] as const;
const digestTypeRaw = getArg('--digest');
if (digestTypeRaw && !VALID_DIGEST_TYPES.includes(digestTypeRaw as typeof VALID_DIGEST_TYPES[number])) {
  console.error(`Invalid digest type: "${digestTypeRaw}". Use: weekly, monthly, annual, or actions`);
  process.exit(1);
}
const digestType = digestTypeRaw as 'weekly' | 'monthly' | 'annual' | 'actions' | null;
const appendTo = getArg('--append-to');

// ============================================================================
// Types
// ============================================================================

interface DigestReport {
  id: string;
  type: 'weekly' | 'monthly' | 'daily_actions' | 'annual';
  period_start: string;
  period_end: string;
  content: unknown;
  markdown: string;
  created_at: string;
}

// ============================================================================
// Supabase Client (minimal, reused from obsidian-sync pattern)
// ============================================================================

async function supabaseFetch<T>(
  url: string,
  serviceRoleKey: string,
  table: string,
  query: string
): Promise<T> {
  const fullUrl = `${url}/rest/v1/${table}?${query}`;

  const response = await fetch(fullUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': serviceRoleKey,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase GET ${table} failed (${response.status}): ${errorText}`);
  }

  return response.json() as T;
}

// ============================================================================
// Input Resolution
// ============================================================================

/**
 * Resolve the input to slide-ready Markdown content + a title.
 */
async function resolveInput(): Promise<{ markdown: string; resolvedTitle: string }> {
  // Option 1: File input
  if (inputFile) {
    if (!fs.existsSync(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }
    const raw = fs.readFileSync(inputFile, 'utf-8');
    const { normalizeMarkdownForSlides } = await import('../src/services/google-slides');
    const markdown = normalizeMarkdownForSlides(raw);
    const resolvedTitle = title || path.basename(inputFile, path.extname(inputFile));
    return { markdown, resolvedTitle };
  }

  // Option 2: Supabase digest
  if (source === 'supabase') {
    return resolveSupabaseDigest();
  }

  // Option 3: Topic (free-form)
  if (topic) {
    const { formatTopicAsSlideMarkdown } = await import('../src/services/google-slides');
    const content = generateTopicContent(topic);
    const markdown = formatTopicAsSlideMarkdown(topic, content);
    const resolvedTitle = title || topic;
    return { markdown, resolvedTitle };
  }

  throw new Error(
    'No input specified. Use one of: --file <path>, --topic "<text>", --source supabase --digest <type>'
  );
}

/**
 * Fetch latest digest from Supabase and format as slide Markdown.
 */
async function resolveSupabaseDigest(): Promise<{ markdown: string; resolvedTitle: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for --source supabase');
  }

  const typeFilter = digestType
    ? `type=eq.${digestType === 'actions' ? 'daily_actions' : digestType}`
    : 'type=eq.weekly';

  const reports = await supabaseFetch<DigestReport[]>(
    supabaseUrl,
    serviceRoleKey,
    'digest_reports',
    `select=id,type,period_start,period_end,content,markdown,created_at&${typeFilter}&order=created_at.desc&limit=1`
  );

  if (reports.length === 0) {
    throw new Error(`No ${digestType || 'weekly'} digest found in Supabase`);
  }

  const report = reports[0];
  const { formatDigestAsSlideMarkdown, formatActionItemsAsSlideMarkdown } = await import('../src/services/google-slides');

  const typeLabels: Record<string, string> = {
    weekly: 'Weekly Digest',
    monthly: 'Monthly Digest',
    annual: 'Annual Digest',
    daily_actions: 'Action Items',
  };
  const resolvedTitle = title || `${typeLabels[report.type] || report.type}: ${report.period_start.slice(0, 10)}`;

  // Parse the content JSON into the expected digest structure
  let content: unknown;
  if (typeof report.content === 'string') {
    try {
      content = JSON.parse(report.content);
    } catch {
      throw new Error(`Failed to parse digest report content as JSON (report id: ${report.id})`);
    }
  } else {
    content = report.content;
  }

  let markdown: string;

  if (report.type === 'daily_actions') {
    markdown = formatActionItemsAsSlideMarkdown(content, resolvedTitle);
  } else {
    markdown = formatDigestAsSlideMarkdown(content, resolvedTitle);
  }

  return { markdown, resolvedTitle };
}

/**
 * Generate placeholder content for a topic.
 * In practice, this would be enriched by AI or user-provided content.
 */
function generateTopicContent(topicText: string): string {
  return [
    `# ${topicText}`,
    '',
    '## Key Points',
    '',
    '* Point 1: Overview and context',
    '* Point 2: Current state of the field',
    '* Point 3: Key trends and developments',
    '',
    '## Analysis',
    '',
    '* Strengths and opportunities',
    '* Challenges and risks',
    '* Recommended next steps',
    '',
    '## Conclusion',
    '',
    '* Summary of key takeaways',
    '* Call to action',
  ].join('\n');
}

// ============================================================================
// Route Execution
// ============================================================================

/**
 * Route A: Markdown → Google Slides (via REST API)
 */
async function executeRouteA(
  markdown: string,
  resolvedTitle: string
): Promise<{ slidesUrl?: string; slidesId?: string }> {
  if (isDryRun) {
    console.log('\n--- Generated Slide Markdown (dry run) ---');
    console.log(markdown);
    console.log('--- End ---\n');
    return {};
  }

  const { authenticate } = await import('../src/services/google-auth');
  const { generateSlidesFromMarkdown } = await import('../src/services/google-slides');

  // Authenticate
  console.log('  Authenticating...');
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || undefined;
  const { accessToken } = await authenticate(credentialsPath);

  const result = await generateSlidesFromMarkdown({
    markdown,
    title: resolvedTitle,
    accessToken,
    appendTo: appendTo || undefined,
  });

  console.log(`  Google Slides URL: ${result.slidesUrl}`);
  console.log(`  Slides ID: ${result.slidesId}`);

  return { slidesUrl: result.slidesUrl, slidesId: result.slidesId };
}

/**
 * Route B: Source → NotebookLM notebook → slide deck generation
 */
async function executeRouteB(
  markdown: string,
  resolvedTitle: string,
  slidesId?: string
): Promise<{ notebookName?: string }> {
  if (isDryRun) {
    console.log('\n--- Route B: NotebookLM (dry run) ---');
    console.log(`  Title: ${resolvedTitle}`);
    console.log(`  Content length: ${markdown.length} chars`);
    if (slidesId) {
      console.log(`  Google Slides source: ${slidesId}`);
    }
    console.log('--- End ---\n');
    return {};
  }

  const { authenticate, resolveProjectNumber } = await import('../src/services/google-auth');
  const { createNotebook, addSources, generateSlideDeck } = await import('../src/services/notebooklm');
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || undefined;
  const projectId = process.env.GCP_PROJECT_ID;

  if (!projectId) {
    throw new Error('GCP_PROJECT_ID environment variable required for Route B');
  }

  // Authenticate
  console.log('  Authenticating...');
  const { accessToken } = await authenticate(credentialsPath);

  // Resolve project number
  console.log('  Resolving project number...');
  const projectNumber = await resolveProjectNumber(accessToken, projectId);

  const config = {
    projectNumber,
    location: 'us',
    appId: 'default',
  };

  // Create notebook
  console.log('  Creating notebook...');
  const notebookName = await createNotebook(config, accessToken, resolvedTitle);
  console.log(`  Notebook: ${notebookName}`);

  // Add sources
  const sources = [];

  // Add text content as inline source
  sources.push({
    type: 'text' as const,
    title: resolvedTitle,
    content: markdown,
  });

  // If Route A produced a Slides ID, add it as a Google Slides source
  if (slidesId) {
    sources.push({
      type: 'googleSlides' as const,
      resourceId: slidesId,
    });
  }

  console.log(`  Adding ${sources.length} source(s)...`);
  await addSources(config, accessToken, notebookName, sources);

  // Generate slide deck via CLI
  console.log('  Generating slide deck...');
  const notebookUrl = `https://notebooklm.google.com/notebook/${notebookName.split('/').pop()}`;
  try {
    await generateSlideDeck(notebookUrl);
    console.log(`  Notebook URL: ${notebookUrl}`);
  } catch (error) {
    console.warn(`  Slide deck generation via CLI failed: ${String(error)}`);
    console.log(`  Notebook created. Generate slides manually at: ${notebookUrl}`);
  }

  return { notebookName };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('🎯 Google Slides / NotebookLM Generator');
  console.log(`  Route: ${route}`);
  if (isDryRun) console.log('  Mode: DRY RUN');
  console.log('');

  // Resolve input
  console.log('Resolving input...');
  const { markdown, resolvedTitle } = await resolveInput();
  console.log(`  Title: ${resolvedTitle}`);
  console.log(`  Content: ${markdown.length} chars`);
  console.log('');

  let slidesId: string | undefined;

  // Execute Route A
  if (route === 'a' || route === 'both') {
    console.log('Route A: Markdown → Google Slides');
    const resultA = await executeRouteA(markdown, resolvedTitle);
    slidesId = resultA.slidesId;
    console.log('');
  }

  // Execute Route B
  if (route === 'b' || route === 'both') {
    console.log('Route B: NotebookLM Enterprise');
    await executeRouteB(markdown, resolvedTitle, slidesId);
    console.log('');
  }

  console.log('Done.');
}

// Run
main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
