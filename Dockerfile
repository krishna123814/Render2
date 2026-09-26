# Dockerfile — render.ts (WebSocket-only Binance proxy) ke liye
# Render par "Docker" runtime environment select karke isi repo/folder ko deploy karo.

FROM denoland/deno:alpine-2.0.0

WORKDIR /app

# Sirf render.ts copy ho raha hai — main.ts is deployment mein nahi hona chahiye
# (dono alag Render account/service hain, alag IP ke liye).
COPY render.ts .

# Deno permissions ko build-time par hi cache/check kar lete hain (startup fast ho)
RUN deno cache render.ts

# Render khud PORT env var inject karta hai — render.ts usko already read karta hai
EXPOSE 8000

# --allow-net: Binance WS (outbound) + Render ka apna HTTP server (inbound)
# --allow-env: PORT, IDLE_STOP_SEC env vars padhne ke liye
CMD ["run", "--allow-net", "--allow-env", "render.ts"]
