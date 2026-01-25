# Integration Guide: Whisper Transcription Service

## Quick Start (5 minutes)

### 1. Add route to your router

```typescript
// src/index.ts or src/router.ts
import { transcribeAudio } from './services/transcription';

// Add this route handler
router.post('/api/transcribe', async (request, env) => {
  try {
    // Parse form data
    const formData = await request.formData();
    const audioEntry = formData.get('audio');

    if (!audioEntry || typeof audioEntry === 'string') {
      return new Response(
        JSON.stringify({ error: 'No audio file provided' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get language hint (optional)
    const languageEntry = formData.get('language');
    const language = typeof languageEntry === 'string' ? languageEntry : undefined;

    // Transcribe
    const audioBuffer = await (audioEntry as File).arrayBuffer();
    const result = await transcribeAudio(env, audioBuffer, { language });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Transcription failed',
        details: String(error)
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
```

### 2. Test with curl

```bash
# Transcribe an audio file
curl -X POST http://localhost:8787/api/transcribe \
  -F "audio=@/path/to/audio.mp3" \
  -F "language=en"

# Response:
# {
#   "text": "Hello, this is a test transcription.",
#   "language": "en",
#   "confidence": 0.85,
#   "duration_seconds": 120,
#   "vtt": "WEBVTT\n\n1\n..."
# }
```

### 3. Test with JavaScript fetch

```javascript
const formData = new FormData();
formData.append('audio', audioFile);
formData.append('language', 'en');

const response = await fetch('/api/transcribe', {
  method: 'POST',
  body: formData
});

const result = await response.json();
console.log(result.text);
```

---

## Channel Integration Examples

### Telegram Voice Messages

```typescript
// src/handlers/channels/telegram.ts
import { transcribeAudio } from '../../services/transcription';

async function handleVoiceMessage(message: TelegramMessage, env: Env) {
  // Download audio file from Telegram
  const fileResponse = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${message.voice.file_id}`
  );
  const fileData = await fileResponse.json();

  // Fetch audio file
  const audioResponse = await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`
  );
  const audioBuffer = await audioResponse.arrayBuffer();

  // Transcribe
  const result = await transcribeAudio(env, audioBuffer);

  // Send transcription back to user
  await sendTelegramMessage(message.chat.id, `📝 Transcription:\n${result.text}`);
}
```

### Discord Voice Notes

```typescript
// src/handlers/discord.ts
import { transcribeAudio } from '../services/transcription';

async function handleDiscordAudioAttachment(attachment: DiscordAttachment, env: Env) {
  // Download audio from Discord CDN
  const audioResponse = await fetch(attachment.url);
  const audioBuffer = await audioResponse.arrayBuffer();

  // Transcribe
  const result = await transcribeAudio(env, audioBuffer, {
    language: 'en' // or detect from server locale
  });

  return {
    content: `🎤 Audio transcription:\n\`\`\`\n${result.text}\n\`\`\``,
    embeds: [
      {
        title: 'Transcription Details',
        fields: [
          { name: 'Language', value: result.language, inline: true },
          { name: 'Confidence', value: `${(result.confidence * 100).toFixed(0)}%`, inline: true },
          { name: 'Duration', value: `${result.duration_seconds}s`, inline: true }
        ]
      }
    ]
  };
}
```

### WhatsApp Audio Messages

```typescript
// src/handlers/channels/whatsapp.ts
import { transcribeAudio } from '../../services/transcription';

async function handleWhatsAppAudio(message: WhatsAppMessage, env: Env) {
  // Download audio from WhatsApp Business API
  const mediaResponse = await fetch(
    `https://graph.facebook.com/v21.0/${message.audio.id}`,
    {
      headers: {
        'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`
      }
    }
  );
  const mediaData = await mediaResponse.json();

  // Fetch audio file
  const audioResponse = await fetch(mediaData.url, {
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`
    }
  });
  const audioBuffer = await audioResponse.arrayBuffer();

  // Transcribe
  const result = await transcribeAudio(env, audioBuffer);

  // Send back transcription
  await sendWhatsAppMessage(message.from, {
    text: {
      body: `📝 Audio transcription:\n\n${result.text}\n\n_Confidence: ${(result.confidence * 100).toFixed(0)}%_`
    }
  });
}
```

---

## Advanced Integration Patterns

### 1. Queue-based Processing (Async)

```typescript
// For large files, use Cloudflare Queues
export async function queueTranscription(audioUrl: string, env: Env) {
  await env.TRANSCRIPTION_QUEUE.send({
    url: audioUrl,
    timestamp: Date.now()
  });

  return { status: 'queued', message: 'Transcription will be processed shortly' };
}

// Consumer
export default {
  async queue(batch: MessageBatch<TranscriptionJob>, env: Env) {
    for (const message of batch.messages) {
      const { url } = message.body;

      // Fetch and transcribe
      const audioResponse = await fetch(url);
      const audioBuffer = await audioResponse.arrayBuffer();
      const result = await transcribeAudio(env, audioBuffer);

      // Store result in D1 or KV
      await env.DB.prepare(
        'INSERT INTO transcriptions (url, text, confidence) VALUES (?, ?, ?)'
      ).bind(url, result.text, result.confidence).run();

      message.ack();
    }
  }
};
```

### 2. Caching with KV

```typescript
import { transcribeAudio } from './services/transcription';
import { createHash } from 'crypto';

async function transcribeWithCache(
  audioBuffer: ArrayBuffer,
  env: Env,
  language?: string
): Promise<TranscriptionResult> {
  // Generate hash of audio for cache key
  const hash = createHash('sha256').update(new Uint8Array(audioBuffer)).digest('hex');
  const cacheKey = `transcription:${hash}:${language || 'auto'}`;

  // Check cache
  const cached = await env.CACHE?.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Transcribe
  const result = await transcribeAudio(env, audioBuffer, { language });

  // Cache for 24 hours
  await env.CACHE?.put(cacheKey, JSON.stringify(result), {
    expirationTtl: 86400
  });

  return result;
}
```

### 3. Batch Processing with R2

```typescript
async function processBatchFromR2(bucket: R2Bucket, env: Env) {
  // List audio files in R2
  const files = await bucket.list({ prefix: 'audio-uploads/' });

  const results = await Promise.all(
    files.objects.map(async (obj) => {
      // Fetch from R2
      const audioFile = await bucket.get(obj.key);
      if (!audioFile) return null;

      const audioBuffer = await audioFile.arrayBuffer();

      // Transcribe
      const result = await transcribeAudio(env, audioBuffer);

      // Save transcription to R2
      await bucket.put(`transcriptions/${obj.key}.json`, JSON.stringify(result));

      return { file: obj.key, ...result };
    })
  );

  return results.filter(r => r !== null);
}
```

### 4. Subtitle Generation Pipeline

```typescript
async function generateSubtitles(videoUrl: string, env: Env) {
  // Extract audio from video (use ffmpeg.wasm or external service)
  const audioBuffer = await extractAudio(videoUrl);

  // Transcribe
  const result = await transcribeAudio(env, audioBuffer);

  if (!result.vtt) {
    throw new Error('WebVTT not available for this transcription');
  }

  // Upload VTT to R2
  await env.SUBTITLES_BUCKET.put(
    `${videoUrl.split('/').pop()}.vtt`,
    result.vtt
  );

  return {
    subtitles_url: `https://cdn.example.com/subtitles/${videoUrl.split('/').pop()}.vtt`,
    text: result.text,
    language: result.language
  };
}
```

---

## API Endpoint Examples

### RESTful API

```typescript
// POST /api/transcribe
router.post('/api/transcribe', handleAudioUpload);

// POST /api/transcribe/url
router.post('/api/transcribe/url', async (req, env) => {
  const { url, language } = await req.json();
  const audioResponse = await fetch(url);
  const audioBuffer = await audioResponse.arrayBuffer();
  const result = await transcribeAudio(env, audioBuffer, { language });
  return Response.json(result);
});

// POST /api/transcribe/base64
router.post('/api/transcribe/base64', async (req, env) => {
  const { audio, language } = await req.json();
  const result = await transcribeAudio(env, audio, { language });
  return Response.json(result);
});

// GET /api/transcribe/:id/vtt
router.get('/api/transcribe/:id/vtt', async (req, env) => {
  const { id } = req.params;
  const cached = await env.CACHE.get(`transcription:${id}`);
  const result = JSON.parse(cached);

  return new Response(result.vtt, {
    headers: {
      'Content-Type': 'text/vtt',
      'Content-Disposition': `attachment; filename="${id}.vtt"`
    }
  });
});
```

---

## Error Handling Best Practices

```typescript
async function robustTranscription(
  audioBuffer: ArrayBuffer,
  env: Env,
  options?: TranscriptionOptions
): Promise<TranscriptionResult | { error: string }> {
  try {
    // Validate audio size
    if (audioBuffer.byteLength === 0) {
      return { error: 'Empty audio file' };
    }

    if (audioBuffer.byteLength > 100 * 1024 * 1024) {
      return { error: 'Audio file too large (max 100MB)' };
    }

    // Transcribe
    const result = await transcribeAudio(env, audioBuffer, options);

    // Validate result
    if (!result.text || result.text.trim().length === 0) {
      return { error: 'No speech detected in audio' };
    }

    if (result.confidence < 0.3) {
      return {
        error: 'Low confidence transcription',
        ...result
      };
    }

    return result;
  } catch (error) {
    console.error('Transcription error:', error);
    return { error: String(error) };
  }
}
```

---

## Monitoring and Logging

```typescript
async function transcribeWithMetrics(
  audioBuffer: ArrayBuffer,
  env: Env,
  options?: TranscriptionOptions
): Promise<TranscriptionResult> {
  const startTime = Date.now();

  try {
    const result = await transcribeAudio(env, audioBuffer, options);

    // Log success metrics
    console.log('Transcription success', {
      size: audioBuffer.byteLength,
      duration: Date.now() - startTime,
      textLength: result.text.length,
      confidence: result.confidence,
      language: result.language
    });

    return result;
  } catch (error) {
    // Log failure metrics
    console.error('Transcription failed', {
      size: audioBuffer.byteLength,
      duration: Date.now() - startTime,
      error: String(error)
    });

    throw error;
  }
}
```

---

## Deployment Checklist

- [ ] Add route to router
- [ ] Test with sample audio files
- [ ] Configure environment variables (if needed)
- [ ] Set up monitoring/logging
- [ ] Add rate limiting (optional)
- [ ] Configure caching (optional)
- [ ] Test error scenarios
- [ ] Update API documentation
- [ ] Deploy to production
- [ ] Monitor for first 24h

---

## Support

For issues or questions:
1. Check the [README](src/services/README.md)
2. Review [usage examples](src/services/transcription.example.ts)
3. Run the test suite: `npm test src/services/transcription.test.ts`
4. Check Cloudflare Workers AI status: https://www.cloudflarestatus.com/
