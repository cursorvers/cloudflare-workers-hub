/**
 * Script to create API key -> userId mappings in KV
 *
 * Usage:
 *   npx tsx scripts/create-api-key-mapping.ts <apiKey> <userId>
 *
 * Example:
 *   npx tsx scripts/create-api-key-mapping.ts "sk-abc123..." "user_12345"
 */

async function hashAPIKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 16);
}

async function createMapping(apiKey: string, userId: string) {
  const keyHash = await hashAPIKey(apiKey);
  const mappingKey = `apikey:mapping:${keyHash}`;

  console.log('Creating API key mapping:');
  console.log('  Key hash:', keyHash);
  console.log('  KV Key:', mappingKey);
  console.log('  User ID:', userId);
  console.log('');
  console.log('Run this Wrangler command to create the mapping:');
  console.log('');
  console.log(`wrangler kv:key put --binding=CACHE "${mappingKey}" '{"userId":"${userId}"}'`);
  console.log('');
  console.log('Or via API:');
  console.log('');
  console.log(`curl -X PUT "https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/${mappingKey}" \\`);
  console.log(`  -H "Authorization: Bearer {api_token}" \\`);
  console.log(`  --data '{"userId":"${userId}"}'`);
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length !== 2) {
  console.error('Usage: npx tsx scripts/create-api-key-mapping.ts <apiKey> <userId>');
  console.error('');
  console.error('Example:');
  console.error('  npx tsx scripts/create-api-key-mapping.ts "sk-abc123..." "user_12345"');
  process.exit(1);
}

const [apiKey, userId] = args;

if (!apiKey || !userId) {
  console.error('Error: Both apiKey and userId are required');
  process.exit(1);
}

if (apiKey.length < 16) {
  console.error('Error: API key seems too short. Please provide the full key.');
  process.exit(1);
}

createMapping(apiKey, userId).catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
