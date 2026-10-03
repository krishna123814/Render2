# telegram-relay

HF Space se aaya message Telegram ko forward karta hai, aur Telegram me "today plan" likhne par aaj ka plan wapas bhejta hai.

## Render setup
- New → Web Service → ye GitHub repo chuno
- Runtime: Node, Build Command: (khaali), Start Command: `node telegram_relay.js`
- Environment: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RELAY_SECRET` (lamba random, 16+ chars)
- Naya: `HF_PLAN_URL` = HF Space ka URL (jaise `https://krishan162627-trade.hf.space`). Space private ho to `HF_ACCESS_TOKEN` bhi.
- Webhook apne aap register hota hai (Render ka `RENDER_EXTERNAL_URL` use hota hai) — alag se kuch nahi karna.

## Naya (v1.1)
- Inline ✅/❌ buttons: raat 9 PM ke baad HF `callback_query` bhejta hai; relay HF ke `/api/cmd` ko `/cb ...` deta hai, toast dikhata hai aur us item ki row keyboard se hata deta hai.
- `POST /send` ab `reply_markup` (inline keyboard) leta hai; 4000+ char ka text apne aap tukdon me jaata hai.
- `POST /senddoc` (header `X-Relay-Secret`, body `{filename, b64, caption}`): HF ka roz raat 10 PM ka backup zip Telegram par.
- Telegram API 429 / 5xx / network error par 3 baar retry.
- Bot menu ("/" button) ke commands start par apne aap register hote hain (`setMyCommands`).
- Render par kuch naya set nahi karna; bas `telegram_relay.js` replace karke redeploy.

## Telegram se plan
Bot ko likho: `today plan`, `aaj ka plan`, `plan` ya `/plan`. ("kal ka plan" ignore hota hai.) Sirf `TELEGRAM_CHAT_ID` ka message sunta hai.

## Test
curl -X POST https://<your-service>.onrender.com/send -H "X-Relay-Secret: <RELAY_SECRET>" -H "content-type: application/json" -d '{"text":"test"}'

## Telegram commands (HF app.py)
`help` likho to poori list. Naye: `habit`, `routine`, `dip` (list; `... done 1 2` / `... done all` / `... miss 2 | wajah`), `practice` (`practice 1 3`, `practice 1 +1`),
`todo add text | kal | high`, `todo done <number ya naam>`, `todo del`, `rough del`, `backup`, `undo`.

## HF Space
Sirf `app.py` replace karo (ab koi alag file nahi). Backup ke liye HF me persistent storage (`/data`) on rakho.
