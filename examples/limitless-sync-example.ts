/**
 * Limitless.ai Integration Examples
 *
 * This file demonstrates how to use the Limitless service
 * to sync Pendant voice recordings to your knowledge base.
 */

import { Env } from '../src/types';
import {
  getRecentLifelogs,
  getLifelog,
  downloadAudio,
  syncToKnowledge,
} from '../src/services/limitless';

// ============================================================================
// Example 1: Fetch Recent Lifelogs
// ============================================================================

/**
 * Fetch the most recent lifelogs from Limitless API
 */
async function fetchRecentLifelogsExample(apiKey: string) {
  console.log('📥 Fetching recent lifelogs...');

  const { lifelogs, cursor } = await getRecentLifelogs(apiKey, {
    limit: 10,
  });

  console.log(`✅ Fetched ${lifelogs.length} lifelogs`);

  for (const lifelog of lifelogs) {
    console.log(`\n📝 Lifelog ID: ${lifelog.id}`);
    console.log(`   Summary: ${lifelog.summary || 'N/A'}`);
    console.log(`   Start: ${new Date(lifelog.startTime).toLocaleString()}`);
    console.log(`   Duration: ${lifelog.duration || 'N/A'} seconds`);
    console.log(`   Tags: ${lifelog.tags?.join(', ') || 'None'}`);
  }

  if (cursor) {
    console.log(`\n➡️  More results available (cursor: ${cursor})`);
  }
}

// ============================================================================
// Example 2: Fetch Lifelogs with Time Range
// ============================================================================

/**
 * Fetch lifelogs from the last 24 hours
 */
async function fetchLast24HoursExample(apiKey: string) {
  console.log('📥 Fetching last 24 hours of lifelogs...');

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);

  const { lifelogs } = await getRecentLifelogs(apiKey, {
    limit: 20,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
  });

  console.log(`✅ Found ${lifelogs.length} lifelogs in the last 24 hours`);

  // Group by hour
  const byHour: Record<string, number> = {};

  for (const lifelog of lifelogs) {
    const hour = new Date(lifelog.startTime).toISOString().substring(0, 13);
    byHour[hour] = (byHour[hour] || 0) + 1;
  }

  console.log('\n📊 Distribution by hour:');
  for (const [hour, count] of Object.entries(byHour)) {
    console.log(`   ${hour}: ${count} recording(s)`);
  }
}

// ============================================================================
// Example 3: Pagination
// ============================================================================

/**
 * Fetch all lifelogs using pagination
 */
async function fetchAllLifelogsExample(apiKey: string) {
  console.log('📥 Fetching ALL lifelogs (with pagination)...');

  let allLifelogs: Array<any> = [];
  let cursor: string | undefined = undefined;
  let page = 1;

  do {
    console.log(`\n   Page ${page}...`);

    const result = await getRecentLifelogs(apiKey, {
      limit: 20,
      cursor,
    });

    allLifelogs = [...allLifelogs, ...result.lifelogs];
    cursor = result.cursor;
    page++;

    console.log(`   Fetched ${result.lifelogs.length} lifelogs`);
  } while (cursor);

  console.log(`\n✅ Total: ${allLifelogs.length} lifelogs across ${page - 1} pages`);
}

// ============================================================================
// Example 4: Get Specific Lifelog
// ============================================================================

/**
 * Fetch a specific lifelog by ID
 */
async function fetchSpecificLifelogExample(apiKey: string, lifelogId: string) {
  console.log(`📥 Fetching lifelog: ${lifelogId}...`);

  const lifelog = await getLifelog(apiKey, lifelogId);

  console.log('\n📝 Lifelog Details:');
  console.log(`   ID: ${lifelog.id}`);
  console.log(`   Summary: ${lifelog.summary || 'N/A'}`);
  console.log(`   Start: ${new Date(lifelog.startTime).toLocaleString()}`);
  console.log(`   End: ${new Date(lifelog.endTime).toLocaleString()}`);
  console.log(`   Duration: ${lifelog.duration || 'N/A'} seconds`);
  console.log(`   Tags: ${lifelog.tags?.join(', ') || 'None'}`);

  if (lifelog.transcript) {
    console.log(`\n   Transcript (${lifelog.transcript.length} chars):`);
    console.log(`   ${lifelog.transcript.substring(0, 200)}...`);
  }
}

// ============================================================================
// Example 5: Download Audio
// ============================================================================

/**
 * Download audio recording for a specific time range
 */
async function downloadAudioExample(apiKey: string) {
  console.log('🎵 Downloading audio...');

  // Download 30 minutes of audio starting at 10:00 AM today
  const today = new Date();
  today.setHours(10, 0, 0, 0);
  const startTime = today.toISOString();

  const endDate = new Date(today);
  endDate.setMinutes(30);
  const endTime = endDate.toISOString();

  console.log(`   Range: ${startTime} to ${endTime}`);

  const audioBuffer = await downloadAudio(apiKey, {
    startTime,
    endTime,
    format: 'ogg',
  });

  console.log(`✅ Downloaded ${audioBuffer.byteLength} bytes`);
  console.log(`   Size: ${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
}

// ============================================================================
// Example 6: Simple Sync (Text Only)
// ============================================================================

/**
 * Sync lifelogs to knowledge service (text only, no audio)
 */
async function simpleSyncExample(env: Env, apiKey: string, userId: string) {
  console.log('🔄 Starting simple sync (text only)...');

  const result = await syncToKnowledge(env, apiKey, {
    userId,
    maxAgeHours: 24, // Last 24 hours
    includeAudio: false, // Don't download audio
  });

  console.log('\n✅ Sync completed:');
  console.log(`   Synced: ${result.synced}`);
  console.log(`   Skipped: ${result.skipped}`);
  console.log(`   Errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log('\n❌ Errors encountered:');
    for (const error of result.errors) {
      console.log(`   - ${error}`);
    }
  }
}

// ============================================================================
// Example 7: Full Sync (Text + Audio)
// ============================================================================

/**
 * Sync lifelogs to knowledge service with audio files
 */
async function fullSyncExample(env: Env, apiKey: string, userId: string) {
  console.log('🔄 Starting full sync (text + audio)...');

  const result = await syncToKnowledge(env, apiKey, {
    userId,
    maxAgeHours: 48, // Last 2 days
    includeAudio: true, // Download audio files
  });

  console.log('\n✅ Sync completed:');
  console.log(`   Synced: ${result.synced} lifelogs`);
  console.log(`   Skipped: ${result.skipped} lifelogs`);
  console.log(`   Errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log('\n❌ Errors encountered:');
    for (const error of result.errors) {
      console.log(`   - ${error}`);
    }
  }
}

// ============================================================================
// Example 8: Weekly Batch Sync
// ============================================================================

/**
 * Sync a full week of lifelogs (useful for weekly reviews)
 */
async function weeklySyncExample(env: Env, apiKey: string, userId: string) {
  console.log('🔄 Starting weekly sync...');

  const result = await syncToKnowledge(env, apiKey, {
    userId,
    maxAgeHours: 168, // 7 days
    includeAudio: false,
  });

  console.log('\n📊 Weekly sync report:');
  console.log(`   Period: Last 7 days`);
  console.log(`   Synced: ${result.synced} recordings`);
  console.log(`   Skipped: ${result.skipped} recordings`);
  console.log(`   Success rate: ${((result.synced / (result.synced + result.skipped)) * 100).toFixed(1)}%`);

  if (result.errors.length > 0) {
    console.log(`\n⚠️  ${result.errors.length} errors occurred during sync`);
  }
}

// ============================================================================
// Example 9: Conditional Sync (Skip Empty Recordings)
// ============================================================================

/**
 * Custom sync logic: manually filter lifelogs before syncing
 */
async function conditionalSyncExample(env: Env, apiKey: string, userId: string) {
  console.log('🔄 Starting conditional sync...');

  // 1. Fetch lifelogs
  const { lifelogs } = await getRecentLifelogs(apiKey, {
    limit: 50,
  });

  console.log(`📥 Fetched ${lifelogs.length} lifelogs`);

  // 2. Filter: only lifelogs with meaningful content
  const meaningful = lifelogs.filter((lifelog) => {
    const hasTranscript = lifelog.transcript && lifelog.transcript.length > 50;
    const hasSummary = lifelog.summary && lifelog.summary.length > 20;
    const hasTags = lifelog.tags && lifelog.tags.length > 0;

    return hasTranscript || hasSummary || hasTags;
  });

  console.log(`   Filtered: ${meaningful.length} meaningful lifelogs`);

  // 3. Sync only meaningful ones
  const result = await syncToKnowledge(env, apiKey, {
    userId,
    maxAgeHours: 24,
    includeAudio: false,
  });

  console.log('\n✅ Conditional sync completed');
  console.log(`   Synced: ${result.synced}`);
}

// ============================================================================
// Example 10: Error Handling
// ============================================================================

/**
 * Demonstrate proper error handling
 */
async function errorHandlingExample(env: Env, apiKey: string, userId: string) {
  console.log('🔄 Starting sync with error handling...');

  try {
    const result = await syncToKnowledge(env, apiKey, {
      userId,
      maxAgeHours: 24,
      includeAudio: false,
    });

    if (result.errors.length > 0) {
      console.warn('⚠️  Some lifelogs failed to sync:');
      for (const error of result.errors.slice(0, 5)) {
        console.warn(`   - ${error}`);
      }

      if (result.errors.length > 5) {
        console.warn(`   ... and ${result.errors.length - 5} more errors`);
      }
    }

    if (result.synced > 0) {
      console.log(`✅ Successfully synced ${result.synced} lifelogs`);
    }

    if (result.skipped > 0) {
      console.log(`ℹ️  Skipped ${result.skipped} empty lifelogs`);
    }
  } catch (error) {
    console.error('❌ Sync failed completely:', error);

    // Implement retry logic or fallback
    console.log('🔄 Retrying with smaller time range...');

    try {
      const retryResult = await syncToKnowledge(env, apiKey, {
        userId,
        maxAgeHours: 6, // Smaller window
        includeAudio: false,
      });

      console.log(`✅ Retry succeeded: ${retryResult.synced} synced`);
    } catch (retryError) {
      console.error('❌ Retry also failed:', retryError);
      throw retryError;
    }
  }
}

// ============================================================================
// Run Examples
// ============================================================================

/**
 * Uncomment the examples you want to run
 */
export async function runExamples(env: Env) {
  const apiKey = env.LIMITLESS_API_KEY;
  const userId = 'example-user-123';

  if (!apiKey) {
    console.error('❌ LIMITLESS_API_KEY not configured');
    return;
  }

  // Uncomment to run:

  // await fetchRecentLifelogsExample(apiKey);
  // await fetchLast24HoursExample(apiKey);
  // await fetchAllLifelogsExample(apiKey);
  // await fetchSpecificLifelogExample(apiKey, 'lifelog-id-123');
  // await downloadAudioExample(apiKey);
  // await simpleSyncExample(env, apiKey, userId);
  // await fullSyncExample(env, apiKey, userId);
  // await weeklySyncExample(env, apiKey, userId);
  // await conditionalSyncExample(env, apiKey, userId);
  // await errorHandlingExample(env, apiKey, userId);

  console.log('\n✅ Examples completed');
}
