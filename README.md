# telegram-relay

HF Space se aaya message Telegram ko forward karta hai, aur Telegram me "today plan" likhne par aaj ka plan wapas bhejta hai.

## Render setup
- New → Web Service → ye GitHub repo chuno
- Runtime: Node, Build Command: (khaali), Start Command: `node telegram_relay.js`
- Environment: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RELAY_SECRET` (lamba random, 16+ chars)
- Naya: `HF_PLAN_URL` = HF Space ka URL (jaise `https://krishan162627-trade.hf.space`). Space private ho to `HF_ACCESS_TOKEN` bhi.
- Webhook apne aap register hota hai (Render ka `RENDER_EXTERNAL_URL` use hota hai) — alag se kuch nahi karna.

## Telegram se plan
Bot ko likho: `today plan`, `aaj ka plan`, `plan` ya `/plan`. ("kal ka plan" ignore hota hai.) Sirf `TELEGRAM_CHAT_ID` ka message sunta hai.

## Test
curl -X POST https://<your-service>.onrender.com/send -H "X-Relay-Secret: <RELAY_SECRET>" -H "content-type: application/json" -d '{"text":"test"}'
