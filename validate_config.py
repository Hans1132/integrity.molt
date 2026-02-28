import json

with open('openclaw_agent_config.json') as f:
    data = json.load(f)

print("🔍 KONTROLA DISABLED SERVICES:\n")

# Discord
discord = data.get('channels', {}).get('discord', {})
print(f"Discord: enabled={discord.get('enabled')}, webhookUrl='{discord.get('webhookUrl', 'N/A')}'")

# Sentry
sentry = data.get('monitoring', {}).get('sentry', {})
print(f"Sentry: enabled={sentry.get('enabled')}, keys={list(sentry.keys())}")

# Check specific fields that might cause issues
print("\n🔍 CRITICAL FIELDS:\n")
print(f"metadata.version: {data.get('metadata', {}).get('version')}")
print(f"agents[0].id: {data.get('agents', {}).get('list', [{}])[0].get('id')}")
print(f"channels.telegram.botToken length: {len(data.get('channels', {}).get('telegram', {}).get('botToken', ''))}")
print(f"gateway.auth.token length: {len(data.get('gateway', {}).get('auth', {}).get('token', ''))}")
