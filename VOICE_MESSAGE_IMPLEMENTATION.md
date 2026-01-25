# Voice Message Implementation for Telegram

## Overview

Extended `src/handlers/channels/telegram.ts` to handle voice and audio messages from Telegram Bot API. The implementation includes:

1. **Voice/Audio Message Detection**
2. **File Download from Telegram**
3. **Audio Transcription using Workers AI**
4. **Knowledge Storage in D1 Database**
5. **User Confirmation Reply**

## Architecture

```
Telegram Voice Message
    ↓
Download via Telegram Bot API
    ↓
(Optional) Save to R2 AUDIO_STAGING
    ↓
Transcribe using Workers AI (@cf/openai/whisper)
    ↓
Save to D1 Database (conversations table)
    ↓
Reply to user with transcription
```

## New Types

### TelegramVoice
```typescript
interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;  // audio/ogg
  file_size?: number;
}
```

### TelegramAudio
```typescript
interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  mime_type?: string;
  file_size?: number;
}
```

## New Functions

### 1. `isVoiceOrAudioMessage(message: TelegramMessage): boolean`
Checks if a message contains voice or audio content.

**Usage:**
```typescript
if (isVoiceOrAudioMessage(message)) {
  await handleVoiceMessage(env, update);
}
```

### 2. `handleVoiceMessage(env: Env, update: TelegramUpdate): Promise<Response>`
Main handler for voice/audio messages.

**Process:**
1. Validate message contains voice/audio
2. Download audio file from Telegram
3. Optionally save to R2 for staging
4. Transcribe using Workers AI
5. Save transcription to database
6. Reply to user with confirmation

**Response:**
```json
{
  "success": true,
  "transcription": "Hello, this is a test",
  "duration": 5
}
```

### 3. Internal Helper Functions

#### `downloadTelegramFile(botToken: string, fileId: string): Promise<ArrayBuffer | null>`
Downloads file from Telegram servers using the getFile API.

**Flow:**
1. Call `getFile` API to get `file_path`
2. Download from `https://api.telegram.org/file/bot{token}/{file_path}`
3. Return as `ArrayBuffer`

#### `transcribeAudio(env: Env, audioBuffer: ArrayBuffer): Promise<string | null>`
Transcribes audio using Workers AI Whisper model.

**Model:** `@cf/openai/whisper`

## Integration Example

```typescript
// In your webhook handler
import {
  validateTelegramUpdate,
  isVoiceOrAudioMessage,
  handleVoiceMessage,
  normalizeTelegramEvent
} from './handlers/channels/telegram';

export default {
  async fetch(request: Request, env: Env) {
    const update = await request.json();

    if (!validateTelegramUpdate(update)) {
      return new Response('Invalid update', { status: 400 });
    }

    const message = update.message;

    // Handle voice/audio messages
    if (message && isVoiceOrAudioMessage(message)) {
      return await handleVoiceMessage(env, update);
    }

    // Handle text messages
    const event = normalizeTelegramEvent(update);
    if (event) {
      // Process text message...
    }

    return new Response('OK');
  }
};
```

## Environment Requirements

### Required
- `TELEGRAM_BOT_TOKEN` - Bot token for Telegram API
- `AI` - Workers AI binding for transcription
- `DB` - D1 Database for storing transcriptions

### Optional
- `AUDIO_STAGING` - R2 bucket for archiving audio files

## Database Schema

Transcriptions are stored in the `conversations` table:

```sql
INSERT INTO conversations (
  id,
  user_id,
  channel,
  source,
  role,
  content,
  metadata,
  created_at
) VALUES (
  'telegram_10000_1',
  '123456789',
  'telegram',
  'voice',
  'user',
  'Transcribed text...',
  '{"messageId": 1, "chatId": 987654321, "duration": 5, "fileId": "AwACAgI..."}',
  datetime('now')
);
```

## Error Handling

The implementation handles the following error cases:

1. **Missing Bot Token** → 500 with error message
2. **File Download Failure** → 500 + reply to user with error
3. **Transcription Failure** → 500 + reply to user with error
4. **Missing Message** → 400 Bad Request
5. **No Voice/Audio** → 400 Bad Request

## Testing

Added comprehensive tests in `telegram.test.ts`:

- Voice message detection
- Audio message detection
- Text message filtering
- Successful transcription flow
- Error handling (missing token, download failure, AI failure)
- R2 storage verification
- Database storage verification

**Run tests:**
```bash
npm test src/handlers/channels/telegram.test.ts
```

## User Experience

When a user sends a voice message:

1. Bot receives voice message
2. Downloads and transcribes (typically 2-5 seconds)
3. Replies with: `✅ 音声を文字起こししました:\n\n"[transcription]"`
4. User sees their message transcribed

## Performance

- **Telegram File API**: ~200-500ms
- **Workers AI Whisper**: ~2-4 seconds (depends on audio length)
- **Total latency**: ~3-5 seconds for typical voice messages

## Security

- Uses constant-time comparison for webhook signature verification
- Bot token stored securely in environment variables
- Audio files optionally archived in private R2 bucket
- User data sanitized before storage

## Future Enhancements

1. **Language Detection** - Auto-detect audio language
2. **Speaker Diarization** - Identify multiple speakers
3. **Sentiment Analysis** - Analyze transcription sentiment
4. **Integration with FAQ** - Auto-respond to common voice queries
5. **Audio Quality Check** - Warn users about low-quality audio

## References

- [Telegram Bot API - Voice Messages](https://core.telegram.org/bots/api#voice)
- [Telegram Bot API - getFile](https://core.telegram.org/bots/api#getfile)
- [Workers AI - Whisper Model](https://developers.cloudflare.com/workers-ai/models/automatic-speech-recognition/)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
