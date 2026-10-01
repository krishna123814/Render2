# telegram-relay

HF Space se aaya message Telegram ko forward karta hai.

## Render setup
- New → Web Service → ye GitHub repo chuno
- Runtime: Node, Build Command: (khaali), Start Command: `node telegram_relay.js`
- Environment: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RELAY_SECRET` (lamba random, 16+ chars)

## Test
curl -X POST https://<your-service>.onrender.com/send -H "X-Relay-Secret: <RELAY_SECRET>" -H "content-type: application/json" -d '{"text":"test"}'
