/**
 * Knowledge Storage Service
 *
 * Provides storage and retrieval of knowledge items (notes, conversations, documents)
 * Features:
 * - Store markdown notes in R2 (OBSIDIAN_VAULT bucket)
 * - Generate embeddings using Workers AI (@cf/baai/bge-base-en-v1.5)
 * - Store vectors in Vectorize (KNOWLEDGE_INDEX)
 * - Store metadata in D1
 * - Graceful degradation when bindings are unavailable
 */

import { z } from 'zod';
import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// Zod schema for KnowledgeItem
const KnowledgeItemSchema = z.object({
  id: z.string().optional(),
  userId: z.string().min(1, 'User ID is required'),
  source: z.enum(['telegram', 'whatsapp', 'discord', 'line', 'manual']),
  type: z.enum(['voice_note', 'conversation', 'document']),
  title: z.string().min(1, 'Title is required'),
  content: z.string().min(1, 'Content is required'),
  audioPath: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().datetime().optional(),
});

export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

// Internal database row interface
interface KnowledgeItemRow {
  id: string;
  user_id: string;
  source: string;
  type: string;
  title: string;
  content_preview: string;
  r2_path: string;
  audio_path: string | null;
  vectorize_id: string | null;
  language: string;
  duration_seconds: number | null;
  word_count: number;
  tags: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

// Constants
const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const CONTENT_PREVIEW_LENGTH = 500;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

/**
 * Store a knowledge item
 *
 * @param env - Cloudflare Workers environment
 * @param item - Knowledge item to store
 * @returns ID of the stored item
 * @throws Error if validation fails or storage fails
 */
export async function storeKnowledge(env: Env, item: KnowledgeItem): Promise<string> {
  // Validate input
  const validatedItem = KnowledgeItemSchema.parse(item);

  // Generate ID if not provided
  const id = validatedItem.id || generateId();

  safeLog.info('[Knowledge] Storing knowledge item', {
    id,
    userId: validatedItem.userId,
    source: validatedItem.source,
    type: validatedItem.type,
  });

  try {
    // Step 1: Store markdown content in R2
    const r2Path = await storeContentInR2(env, id, validatedItem);

    // Step 2: Generate and store embedding (with graceful degradation)
    const vectorizeId = await storeEmbedding(env, id, validatedItem);

    // Step 3: Store metadata in D1 (with graceful degradation)
    await storeMetadata(env, id, validatedItem, r2Path, vectorizeId);

    safeLog.info('[Knowledge] Successfully stored knowledge item', {
      id,
      r2Path,
      vectorizeId: vectorizeId || 'skipped',
    });

    return id;
  } catch (error) {
    safeLog.error('[Knowledge] Failed to store knowledge item', {
      id,
      error: String(error),
    });
    throw new Error(`Failed to store knowledge item: ${String(error)}`);
  }
}

/**
 * Search knowledge items by semantic similarity
 *
 * @param env - Cloudflare Workers environment
 * @param query - Search query
 * @param userId - User ID to filter results
 * @param limit - Maximum number of results (default: 10)
 * @returns Array of matching knowledge items
 */
export async function searchKnowledge(
  env: Env,
  query: string,
  userId: string,
  limit = 10
): Promise<KnowledgeItem[]> {
  if (!query || !userId) {
    throw new Error('Query and userId are required');
  }

  safeLog.info('[Knowledge] Searching knowledge items', {
    userId,
    queryLength: query.length,
    limit,
  });

  try {
    // Try semantic search first (if Vectorize available)
    if (env.KNOWLEDGE_INDEX) {
      return await semanticSearch(env, query, userId, limit);
    }

    // Fallback to full-text search (if D1 available)
    if (env.DB) {
      return await fullTextSearch(env, query, userId, limit);
    }

    // No search capabilities available
    safeLog.warn('[Knowledge] No search capabilities available (Vectorize and D1 missing)');
    return [];
  } catch (error) {
    safeLog.error('[Knowledge] Search failed', {
      error: String(error),
    });

    // Try fallback search method
    try {
      if (env.DB) {
        safeLog.info('[Knowledge] Attempting fallback to full-text search');
        return await fullTextSearch(env, query, userId, limit);
      }
    } catch (fallbackError) {
      safeLog.error('[Knowledge] Fallback search also failed', {
        error: String(fallbackError),
      });
    }

    return [];
  }
}

/**
 * Store markdown content in R2
 */
async function storeContentInR2(
  env: Env,
  id: string,
  item: KnowledgeItem
): Promise<string> {
  if (!env.OBSIDIAN_VAULT) {
    throw new Error('R2 bucket OBSIDIAN_VAULT not configured');
  }

  const r2Path = `knowledge/${item.userId}/${id}.md`;

  // Build markdown content
  const markdown = buildMarkdownContent(item);

  try {
    await env.OBSIDIAN_VAULT.put(r2Path, markdown, {
      httpMetadata: {
        contentType: 'text/markdown',
      },
      customMetadata: {
        userId: item.userId,
        source: item.source,
        type: item.type,
        title: item.title,
      },
    });

    safeLog.info('[Knowledge] Stored content in R2', {
      r2Path,
      size: markdown.length,
    });

    return r2Path;
  } catch (error) {
    safeLog.error('[Knowledge] Failed to store content in R2', {
      r2Path,
      error: String(error),
    });
    throw error;
  }
}

/**
 * Generate and store embedding in Vectorize
 */
async function storeEmbedding(
  env: Env,
  id: string,
  item: KnowledgeItem
): Promise<string | null> {
  // Graceful degradation if Vectorize not available
  if (!env.KNOWLEDGE_INDEX) {
    safeLog.warn('[Knowledge] Vectorize not configured, skipping embedding');
    return null;
  }

  try {
    // Generate embedding from title + content
    const textToEmbed = `${item.title}\n\n${item.content}`;
    const embedding = await generateEmbedding(env, textToEmbed);

    // Store in Vectorize
    const vectorizeId = `knowledge_${id}`;
    await env.KNOWLEDGE_INDEX.upsert([
      {
        id: vectorizeId,
        values: embedding,
        metadata: {
          userId: item.userId,
          source: item.source,
          type: item.type,
          title: item.title,
          createdAt: item.createdAt || new Date().toISOString(),
        },
      },
    ]);

    safeLog.info('[Knowledge] Stored embedding in Vectorize', {
      vectorizeId,
      dimensions: embedding.length,
    });

    return vectorizeId;
  } catch (error) {
    safeLog.error('[Knowledge] Failed to store embedding', {
      id,
      error: String(error),
    });
    // Don't throw - graceful degradation
    return null;
  }
}

/**
 * Store metadata in D1
 */
async function storeMetadata(
  env: Env,
  id: string,
  item: KnowledgeItem,
  r2Path: string,
  vectorizeId: string | null
): Promise<void> {
  // Graceful degradation if D1 not available
  if (!env.DB) {
    safeLog.warn('[Knowledge] D1 not configured, skipping metadata storage');
    return;
  }

  const contentPreview = item.content.substring(0, CONTENT_PREVIEW_LENGTH);
  const wordCount = item.content.split(/\s+/).length;
  const tags = item.tags ? item.tags.join(',') : null;
  const createdAt = item.createdAt || new Date().toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO knowledge_items (
        id, user_id, source, type, title, content_preview,
        r2_path, audio_path, vectorize_id, language,
        word_count, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        item.userId,
        item.source,
        item.type,
        item.title,
        contentPreview,
        r2Path,
        item.audioPath || null,
        vectorizeId,
        'ja', // Default language
        wordCount,
        tags,
        createdAt,
        createdAt // updated_at same as created_at initially
      )
      .run();

    safeLog.info('[Knowledge] Stored metadata in D1', {
      id,
      wordCount,
      tags: tags || 'none',
    });
  } catch (error) {
    safeLog.error('[Knowledge] Failed to store metadata in D1', {
      id,
      error: String(error),
    });
    // Don't throw - allow R2 storage to succeed even if D1 fails
  }
}

/**
 * Semantic search using Vectorize
 */
async function semanticSearch(
  env: Env,
  query: string,
  userId: string,
  limit: number
): Promise<KnowledgeItem[]> {
  if (!env.KNOWLEDGE_INDEX) {
    return [];
  }

  try {
    // Generate query embedding
    const queryEmbedding = await generateEmbedding(env, query);

    // Search Vectorize
    const results = await env.KNOWLEDGE_INDEX.query(queryEmbedding, {
      topK: limit,
      filter: { userId },
    });

    safeLog.info('[Knowledge] Semantic search completed', {
      resultsCount: results.matches.length,
    });

    // Convert Vectorize results to KnowledgeItem
    const items: KnowledgeItem[] = [];

    for (const match of results.matches) {
      if (!match.metadata) continue;

      // Fetch full content from R2 if available
      let content = '';
      if (env.OBSIDIAN_VAULT && env.DB) {
        try {
          // Get R2 path from D1
          const dbResult = await env.DB.prepare(
            'SELECT r2_path FROM knowledge_items WHERE vectorize_id = ?'
          )
            .bind(match.id)
            .first<{ r2_path: string }>();

          if (dbResult?.r2_path) {
            const r2Object = await env.OBSIDIAN_VAULT.get(dbResult.r2_path);
            if (r2Object) {
              const fullContent = await r2Object.text();
              // Extract content from markdown (remove frontmatter and title)
              content = extractContentFromMarkdown(fullContent);
            }
          }
        } catch (error) {
          safeLog.warn('[Knowledge] Failed to fetch content from R2', {
            vectorizeId: match.id,
            error: String(error),
          });
        }
      }

      items.push({
        id: match.id.replace('knowledge_', ''),
        userId: match.metadata.userId as string,
        source: match.metadata.source as 'telegram' | 'whatsapp' | 'discord' | 'line' | 'manual',
        type: match.metadata.type as 'voice_note' | 'conversation' | 'document',
        title: match.metadata.title as string,
        content: content || '(content not available)',
        createdAt: match.metadata.createdAt as string,
      });
    }

    return items;
  } catch (error) {
    safeLog.error('[Knowledge] Semantic search failed', {
      error: String(error),
    });
    throw error;
  }
}

/**
 * Full-text search using D1 FTS
 */
async function fullTextSearch(
  env: Env,
  query: string,
  userId: string,
  limit: number
): Promise<KnowledgeItem[]> {
  if (!env.DB) {
    return [];
  }

  try {
    // Search using FTS5 virtual table
    const results = await env.DB.prepare(
      `SELECT k.*
       FROM knowledge_items k
       INNER JOIN knowledge_fts f ON k.rowid = f.rowid
       WHERE f.knowledge_fts MATCH ? AND k.user_id = ?
       ORDER BY k.created_at DESC
       LIMIT ?`
    )
      .bind(query, userId, limit)
      .all<KnowledgeItemRow>();

    safeLog.info('[Knowledge] Full-text search completed', {
      resultsCount: results.results.length,
    });

    // Convert database rows to KnowledgeItem
    const items: KnowledgeItem[] = [];

    for (const row of results.results) {
      // Fetch full content from R2 if available
      let content = row.content_preview;
      if (env.OBSIDIAN_VAULT) {
        try {
          const r2Object = await env.OBSIDIAN_VAULT.get(row.r2_path);
          if (r2Object) {
            const fullContent = await r2Object.text();
            // Extract content from markdown (remove frontmatter if present)
            content = extractContentFromMarkdown(fullContent);
          }
        } catch (error) {
          safeLog.warn('[Knowledge] Failed to fetch full content from R2', {
            r2Path: row.r2_path,
            error: String(error),
          });
        }
      }

      items.push({
        id: row.id,
        userId: row.user_id,
        source: row.source as 'telegram' | 'whatsapp' | 'discord' | 'line' | 'manual',
        type: row.type as 'voice_note' | 'conversation' | 'document',
        title: row.title,
        content,
        audioPath: row.audio_path || undefined,
        tags: row.tags ? row.tags.split(',') : undefined,
        createdAt: row.created_at,
      });
    }

    return items;
  } catch (error) {
    safeLog.error('[Knowledge] Full-text search failed', {
      error: String(error),
    });
    throw error;
  }
}

/**
 * Generate embedding using Workers AI
 */
async function generateEmbedding(env: Env, text: string): Promise<number[]> {
  try {
    const response = (await (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
      EMBEDDING_MODEL,
      { text }
    )) as { data: number[][] };

    if (!response.data || !response.data[0]) {
      throw new Error('Invalid embedding response from Workers AI');
    }

    return response.data[0];
  } catch (error) {
    safeLog.error('[Knowledge] Failed to generate embedding', {
      error: String(error),
      textLength: text.length,
    });
    throw error;
  }
}

/**
 * Build markdown content from KnowledgeItem
 */
function buildMarkdownContent(item: KnowledgeItem): string {
  const frontmatter = [
    '---',
    `title: ${item.title}`,
    `source: ${item.source}`,
    `type: ${item.type}`,
    `userId: ${item.userId}`,
    `createdAt: ${item.createdAt || new Date().toISOString()}`,
  ];

  if (item.tags && item.tags.length > 0) {
    frontmatter.push(`tags: [${item.tags.join(', ')}]`);
  }

  if (item.audioPath) {
    frontmatter.push(`audioPath: ${item.audioPath}`);
  }

  frontmatter.push('---');
  frontmatter.push('');
  frontmatter.push(`# ${item.title}`);
  frontmatter.push('');
  frontmatter.push(item.content);

  return frontmatter.join('\n');
}

/**
 * Extract content from markdown (remove frontmatter)
 */
function extractContentFromMarkdown(markdown: string): string {
  // Remove YAML frontmatter if present
  const frontmatterRegex = /^---\n[\s\S]*?\n---\n+/;
  const contentWithoutFrontmatter = markdown.replace(frontmatterRegex, '');

  // Remove title header if present
  const titleRegex = /^# .+\n+/;
  return contentWithoutFrontmatter.replace(titleRegex, '').trim();
}

/**
 * Generate unique ID for knowledge item
 */
function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 9);
  return `${timestamp}-${randomPart}`;
}
