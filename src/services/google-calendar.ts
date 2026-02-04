/**
 * Google Calendar API Client
 *
 * Fetch today's events or upcoming events from Google Calendar.
 * Used for HEARTBEAT.md time-based proactive suggestions.
 *
 * No npm dependencies — fetch-based, Zod validation, google-auth integration.
 */

import { z } from 'zod';
import { authenticate } from './google-auth';

// ============================================================================
// Schemas
// ============================================================================

const DateTimeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(), // All-day events use 'date' instead
  timeZone: z.string().optional(),
});

const AttendeeSchema = z.object({
  email: z.string().email(),
  displayName: z.string().optional(),
  responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']).optional(),
  self: z.boolean().optional(),
});

const CalendarEventSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  start: DateTimeSchema,
  end: DateTimeSchema,
  attendees: z.array(AttendeeSchema).optional(),
  location: z.string().optional(),
  hangoutLink: z.string().url().optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
});

export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

const CalendarListResponseSchema = z.object({
  items: z.array(CalendarEventSchema).optional(),
  nextPageToken: z.string().optional(),
});

// ============================================================================
// Constants
// ============================================================================

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_CALENDAR_ID = 'primary';

// ============================================================================
// Public API
// ============================================================================

/**
 * Fetch today's events from Google Calendar.
 *
 * @param calendarId - Calendar ID (default: 'primary')
 * @param credentialsPath - Optional path to credentials file
 * @returns Array of calendar events
 */
export async function getTodaysEvents(
  calendarId: string = DEFAULT_CALENDAR_ID,
  credentialsPath?: string
): Promise<CalendarEvent[]> {
  const now = new Date();
  const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

  return fetchEvents({
    calendarId,
    timeMin,
    timeMax,
    credentialsPath,
  });
}

/**
 * Fetch upcoming events within the next N hours.
 *
 * @param hoursAhead - Number of hours to look ahead (default: 24)
 * @param calendarId - Calendar ID (default: 'primary')
 * @param credentialsPath - Optional path to credentials file
 * @returns Array of calendar events
 */
export async function getUpcomingEvents(
  hoursAhead: number = 24,
  calendarId: string = DEFAULT_CALENDAR_ID,
  credentialsPath?: string
): Promise<CalendarEvent[]> {
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000).toISOString();

  return fetchEvents({
    calendarId,
    timeMin,
    timeMax,
    credentialsPath,
  });
}

/**
 * Fetch events within a specific time range.
 *
 * @param options - Query options
 * @returns Array of calendar events
 */
export async function fetchEvents(options: {
  calendarId: string;
  timeMin: string;
  timeMax: string;
  maxResults?: number;
  credentialsPath?: string;
  subject?: string; // Domain-Wide Delegation: email to impersonate
}): Promise<CalendarEvent[]> {
  const { calendarId, timeMin, timeMax, maxResults = 50, credentialsPath, subject } = options;

  // For Domain-Wide Delegation, get subject from env var if not provided
  const userEmail = subject || process.env.GOOGLE_CALENDAR_USER_EMAIL;

  const credentials = await import('./google-auth').then(m => m.loadGoogleCredentials(credentialsPath));
  const tokenResponse = await import('./google-auth').then(m =>
    m.getAccessToken(credentials, 'https://www.googleapis.com/auth/calendar.readonly', userEmail)
  );
  const accessToken = tokenResponse.access_token;

  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?` +
    new URLSearchParams({
      timeMin,
      timeMax,
      orderBy: 'startTime',
      singleEvents: 'true', // Expand recurring events
      maxResults: maxResults.toString(),
    }).toString();

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Calendar API error (${response.status}): ${errorText.substring(0, 300)}`
    );
  }

  const data = await response.json();
  const parsed = CalendarListResponseSchema.parse(data);

  return parsed.items || [];
}

/**
 * Format event for display in HEARTBEAT suggestions.
 *
 * @param event - Calendar event
 * @returns Formatted string
 */
export function formatEventForDisplay(event: CalendarEvent): string {
  const summary = event.summary || '(No title)';

  // Extract time (handle all-day events)
  const startTime = event.start.dateTime
    ? new Date(event.start.dateTime).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '終日';

  const endTime = event.end.dateTime
    ? new Date(event.end.dateTime).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  const timeRange = endTime ? `${startTime}-${endTime}` : startTime;

  // Location (if exists)
  const location = event.location ? ` @ ${event.location}` : '';

  // Attendees count (exclude self)
  const attendeesCount = event.attendees
    ? event.attendees.filter(a => !a.self).length
    : 0;
  const attendeesInfo = attendeesCount > 0 ? ` (${attendeesCount}名)` : '';

  // Status indicator
  const statusIcon = event.status === 'cancelled' ? '❌ ' : '';

  return `${statusIcon}${timeRange} ${summary}${location}${attendeesInfo}`;
}

/**
 * Get summary of today's events for HEARTBEAT.md.
 *
 * @param calendarId - Calendar ID (default: 'primary')
 * @param credentialsPath - Optional path to credentials file
 * @returns Formatted summary string
 */
export async function getTodaysSummary(
  calendarId: string = DEFAULT_CALENDAR_ID,
  credentialsPath?: string
): Promise<string> {
  const events = await getTodaysEvents(calendarId, credentialsPath);

  if (events.length === 0) {
    return '今日の予定はありません。';
  }

  const formattedEvents = events
    .filter(e => e.status !== 'cancelled')
    .map(formatEventForDisplay);

  return `今日の予定（${formattedEvents.length}件）:\n${formattedEvents.map(e => `  • ${e}`).join('\n')}`;
}
