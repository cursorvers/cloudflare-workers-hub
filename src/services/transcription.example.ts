/**
 * Usage Examples for Whisper Transcription Service
 *
 * This file demonstrates how to use the transcription service
 * in various scenarios within Cloudflare Workers.
 */

import { transcribeAudio } from './transcription';
import type { Env } from '../types';

/**
 * Example 1: Transcribe audio from uploaded file (multipart/form-data)
 */
export async function handleAudioUpload(request: Request, env: Env): Promise<Response> {
  try {
    // Parse multipart form data
    const formData = await request.formData();
    const audioFileEntry = formData.get('audio');

    if (!audioFileEntry || typeof audioFileEntry === 'string') {
      return new Response(JSON.stringify({ error: 'No audio file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const audioFile = audioFileEntry as File;

    // Convert file to ArrayBuffer
    const audioBuffer = await audioFile.arrayBuffer();

    // Transcribe with language hint
    const result = await transcribeAudio(env, audioBuffer, {
      language: 'en', // Optional: specify language
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Transcription failed',
        details: String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Example 2: Transcribe audio from Base64 (webhook/API)
 */
export async function handleBase64Audio(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { audio: string; language?: string };

    // Transcribe from Base64
    const result = await transcribeAudio(env, body.audio, {
      language: body.language,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Transcription failed',
        details: String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Example 3: Transcribe audio from external URL
 */
export async function handleAudioURL(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { url: string; language?: string };

    // Fetch audio from URL
    const audioResponse = await fetch(body.url);

    if (!audioResponse.ok) {
      return new Response(
        JSON.stringify({ error: 'Failed to fetch audio from URL' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const audioBuffer = await audioResponse.arrayBuffer();

    // Transcribe
    const result = await transcribeAudio(env, audioBuffer, {
      language: body.language,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Transcription failed',
        details: String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Example 4: Generate subtitles (WebVTT)
 */
export async function handleSubtitleGeneration(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const formData = await request.formData();
    const audioFileEntry = formData.get('audio');

    if (!audioFileEntry || typeof audioFileEntry === 'string') {
      return new Response('No audio file provided', { status: 400 });
    }

    const audioFile = audioFileEntry as File;

    const audioBuffer = await audioFile.arrayBuffer();

    // Transcribe (will generate VTT if word timestamps available)
    const result = await transcribeAudio(env, audioBuffer);

    if (!result.vtt) {
      return new Response(
        JSON.stringify({
          error: 'WebVTT not available',
          suggestion: 'Word timestamps were not provided by the model',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Return VTT file
    return new Response(result.vtt, {
      status: 200,
      headers: {
        'Content-Type': 'text/vtt',
        'Content-Disposition': 'attachment; filename="subtitles.vtt"',
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Subtitle generation failed',
        details: String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Example 5: Batch transcription with queue
 */
export async function handleBatchTranscription(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      audioUrls: string[];
      language?: string;
    };

    if (!body.audioUrls || body.audioUrls.length === 0) {
      return new Response(JSON.stringify({ error: 'No audio URLs provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Process all URLs in parallel
    const results = await Promise.all(
      body.audioUrls.map(async url => {
        try {
          const audioResponse = await fetch(url);
          const audioBuffer = await audioResponse.arrayBuffer();
          const result = await transcribeAudio(env, audioBuffer, {
            language: body.language,
          });

          return {
            url,
            success: true,
            result,
          };
        } catch (error) {
          return {
            url,
            success: false,
            error: String(error),
          };
        }
      })
    );

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Batch transcription failed',
        details: String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Example 6: Transcribe with confidence threshold
 */
export async function handleTranscriptionWithThreshold(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const formData = await request.formData();
    const audioFileEntry = formData.get('audio');
    const minConfidenceEntry = formData.get('min_confidence');
    const minConfidence = parseFloat(
      typeof minConfidenceEntry === 'string' ? minConfidenceEntry : '0.5'
    );

    if (!audioFileEntry || typeof audioFileEntry === 'string') {
      return new Response('No audio file provided', { status: 400 });
    }

    const audioFile = audioFileEntry as File;

    const audioBuffer = await audioFile.arrayBuffer();
    const result = await transcribeAudio(env, audioBuffer);

    if (result.confidence < minConfidence) {
      return new Response(
        JSON.stringify({
          error: 'Low confidence transcription',
          confidence: result.confidence,
          threshold: minConfidence,
          text: result.text,
        }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Transcription failed',
        details: String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Example 7: Integration with existing router
 */
export function registerTranscriptionRoutes(router: any, env: Env) {
  // POST /api/transcribe/upload
  router.post('/api/transcribe/upload', (req: Request) => handleAudioUpload(req, env));

  // POST /api/transcribe/base64
  router.post('/api/transcribe/base64', (req: Request) => handleBase64Audio(req, env));

  // POST /api/transcribe/url
  router.post('/api/transcribe/url', (req: Request) => handleAudioURL(req, env));

  // POST /api/transcribe/subtitles
  router.post('/api/transcribe/subtitles', (req: Request) =>
    handleSubtitleGeneration(req, env)
  );

  // POST /api/transcribe/batch
  router.post('/api/transcribe/batch', (req: Request) =>
    handleBatchTranscription(req, env)
  );
}
