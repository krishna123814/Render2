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

## Naya (v1.2) — raat ki email ka link
- `GET/POST /api/routine_resp`: ✅/❌ jawab-page ab Render se khulta hai (private HF Space ka 404 nahi aata). Relay `HF_ACCESS_TOKEN` lagakar HF se page laata hai; sirf yahi ek path.
- **Karna kya hai:** relay redeploy karo, aur HF Space → Settings → Variables and secrets me `ROUTINE_BASE_URL` = `https://<tumhara-service>.onrender.com` (aakhir me `/` nahi). `HF_ACCESS_TOKEN` Render me set hona zaroori hai (Space private hai).
- Test: browser me `https://<service>.onrender.com/api/routine_resp` kholo — "link galat ya expire" (403) page aaye to proxy chal raha hai.

## Telegram se plan
Bot ko likho: `today plan`, `aaj ka plan`, `plan` ya `/plan`. ("kal ka plan" ignore hota hai.) Sirf `TELEGRAM_CHAT_ID` ka message sunta hai.

## Test
curl -X POST https://<your-service>.onrender.com/send -H "X-Relay-Secret: <RELAY_SECRET>" -H "content-type: application/json" -d '{"text":"test"}'

## Telegram commands (HF app.py)
`help` likho to poori list. Naye: `habit`, `routine`, `dip` (list; `... done 1 2` / `... done all` / `... miss 2 | wajah`), `practice` (`practice 1 3`, `practice 1 +1`),
`todo add text | kal | high`, `todo done <number ya naam>`, `todo del`, `rough del`, `backup`, `undo`.

## HF Space
Sirf `app.py` replace karo (ab koi alag file nahi). Backup ke liye HF me persistent storage (`/data`) on rakho.

## Naye Telegram commands (v1.3)
- **Kai kaam ek saath:** pehli line `todo add` (ya `+`), neeche har line ek kaam. Har line me `| kal | high` chalega. Rough ke liye `rough add` ya `r`. Max 30. `undo` se sab ek saath wapas.
- **Shortcuts:** `+ doodh lana | kal` = todo add, `r idea` = rough add.
- **`find <shabd>`:** To-Do, Rough, Info, Travel sab me dhoondho.
- **`status`:** server, background threads, Fyers expiry flag, aakhri backup, disk.
- Relay ab 3000 akshar tak ka message HF ko bhejta hai (pehle 1000).
