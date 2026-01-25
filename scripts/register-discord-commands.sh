#!/bin/bash
# Discord スラッシュコマンド登録スクリプト
# Usage: DISCORD_BOT_TOKEN=xxx ./scripts/register-discord-commands.sh

APPLICATION_ID="1464654211420782632"

if [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "Error: DISCORD_BOT_TOKEN environment variable is required"
  echo "Usage: DISCORD_BOT_TOKEN=xxx ./scripts/register-discord-commands.sh"
  exit 1
fi

echo "Registering Discord slash commands..."

# /hello command
curl -s -X POST "https://discord.com/api/v10/applications/${APPLICATION_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"hello","description":"Say hello to the Orchestrator"}' | jq .

# /status command
curl -s -X POST "https://discord.com/api/v10/applications/${APPLICATION_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"status","description":"Check Orchestrator Hub status"}' | jq .

# /ask command with option
curl -s -X POST "https://discord.com/api/v10/applications/${APPLICATION_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"ask",
    "description":"Ask the Orchestrator a question",
    "options":[{
      "name":"question",
      "description":"Your question",
      "type":3,
      "required":true
    }]
  }' | jq .

echo "Done! Commands may take up to 1 hour to propagate globally."
