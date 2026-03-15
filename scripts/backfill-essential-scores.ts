#!/usr/bin/env npx tsx
/**
 * Backfill Essential Scores
 *
 * Computes is_essential and essential_score for all existing processed_lifelogs
 * that don't have these fields set yet.
 *
 * Prerequisites:
 *   - Migration 0013_essential_scoring.sql must be applied first
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 *
 * Usage:
 *   npx tsx scripts/backfill-essential-scores.ts
 *   npx tsx scripts/backfill-essential-scores.ts --dry-run
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';
import { classifyEssential } from '../src/services/lifelog-processor';

const envPath = fs.existsSync(path.join(process.cwd(), '.env.local')) ? '.env.local' : '.env';
config({ path: envPath });

const isDryRun = process.argv.includes('--dry-run');
const BATCH_SIZE = 50;

interface LifelogRow {
  id: string;
  limitless_id: string;
  classification: string;
  confidence_score: number | null;
  duration_seconds: number | null;
  key_insights: string | string[];
  action_items: string | string[];
  is_starred: boolean;
  original_length: number | null;
  is_essential: boolean | null;
  essential_score: number | null;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  console.log(`${isDryRun ? '[DRY RUN] ' : ''}Backfilling essential scores...`);

  // Fetch all unscored rows
  let offset = 0;
  let totalProcessed = 0;
  let totalEssential = 0;
  let totalNoise = 0;

  while (true) {
    const query = `select=id,limitless_id,classification,confidence_score,duration_seconds,key_insights,action_items,is_starred,original_length,is_essential,essential_score&is_essential=is.null&order=start_time.asc&limit=${BATCH_SIZE}&offset=${offset}`;

    const response = await fetch(`${supabaseUrl}/rest/v1/processed_lifelogs?${query}`, {
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (errorText.includes('42703')) {
        console.error('Columns is_essential/essential_score do not exist. Apply migration 0013 first.');
        console.error('Run this SQL in Supabase Dashboard SQL Editor:');
        console.error('  cat supabase/migrations/0013_essential_scoring.sql');
        process.exit(1);
      }
      throw new Error(`Fetch failed (${response.status}): ${errorText}`);
    }

    const rows = await response.json() as LifelogRow[];
    if (rows.length === 0) break;

    console.log(`Processing batch: ${offset + 1} - ${offset + rows.length}`);

    for (const row of rows) {
      const result = classifyEssential({
        classification: row.classification,
        confidenceScore: row.confidence_score,
        durationSeconds: row.duration_seconds,
        keyInsightsCount: parseJsonArray(row.key_insights).length,
        actionItemsCount: parseJsonArray(row.action_items).length,
        isStarred: row.is_starred,
        originalLength: row.original_length,
      });

      if (result.isEssential) {
        totalEssential++;
      } else if (result.essentialScore < 0.3) {
        totalNoise++;
      }

      if (!isDryRun) {
        const patchResponse = await fetch(
          `${supabaseUrl}/rest/v1/processed_lifelogs?id=eq.${row.id}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${serviceRoleKey}`,
              'apikey': serviceRoleKey,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({
              is_essential: result.isEssential,
              essential_score: result.essentialScore,
            }),
          }
        );

        if (!patchResponse.ok) {
          console.error(`Failed to update ${row.id}: ${await patchResponse.text()}`);
        }
      }

      totalProcessed++;
    }

    offset += rows.length;

    if (rows.length < BATCH_SIZE) break;
  }

  console.log('');
  console.log('=== Backfill Summary ===');
  console.log(`Total processed: ${totalProcessed}`);
  console.log(`Essential: ${totalEssential}`);
  console.log(`Noise (< 0.3): ${totalNoise}`);
  console.log(`Middle: ${totalProcessed - totalEssential - totalNoise}`);
  if (isDryRun) {
    console.log('(dry run — no changes written)');
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
