#!/usr/bin/env tsx
/**
 * Add Calendar ACL for Service Account
 *
 * Google Calendar UIではService Accountを直接追加できないため、
 * Calendar APIを使ってプログラマティックにアクセス権を追加する。
 */

import { authenticate } from '../src/services/google-auth';

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

interface AddAclOptions {
  calendarId: string;
  serviceAccountEmail: string;
  role?: 'reader' | 'writer' | 'owner';
}

async function addCalendarAcl(options: AddAclOptions): Promise<void> {
  const { calendarId, serviceAccountEmail, role = 'reader' } = options;

  console.log(`Adding ACL for ${serviceAccountEmail} to calendar ${calendarId}...`);

  const { accessToken } = await authenticate();

  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/acl`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      role,
      scope: {
        type: 'user',
        value: serviceAccountEmail,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to add ACL (${response.status}): ${errorText.substring(0, 300)}`
    );
  }

  const result = await response.json();
  console.log('✅ ACL added successfully:');
  console.log(`   Calendar: ${calendarId}`);
  console.log(`   Service Account: ${serviceAccountEmail}`);
  console.log(`   Role: ${role}`);
  console.log(`   ACL ID: ${result.id}`);
}

async function listCalendars(): Promise<void> {
  console.log('Fetching calendar list...');

  const { accessToken } = await authenticate();

  const url = `${CALENDAR_API_BASE}/users/me/calendarList`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list calendars (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  console.log('\nAvailable calendars:');
  for (const calendar of data.items || []) {
    console.log(`  - ${calendar.summary} (${calendar.id})`);
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    await listCalendars();
    return;
  }

  const calendarIdIndex = args.indexOf('--calendar');
  const serviceAccountIndex = args.indexOf('--service-account');

  if (calendarIdIndex === -1 || serviceAccountIndex === -1) {
    console.error('Usage:');
    console.error('  npx tsx scripts/add-calendar-acl.ts --list');
    console.error('  npx tsx scripts/add-calendar-acl.ts --calendar <calendar-id> --service-account <email>');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx scripts/add-calendar-acl.ts --calendar primary --service-account sa@project.iam.gserviceaccount.com');
    process.exit(1);
  }

  const calendarId = args[calendarIdIndex + 1];
  const serviceAccountEmail = args[serviceAccountIndex + 1];

  await addCalendarAcl({
    calendarId,
    serviceAccountEmail,
    role: 'reader',
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
