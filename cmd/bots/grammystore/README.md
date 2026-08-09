# NexGram grammY store and authentication bot

This service is a JavaScript/grammY port of the supplied legacy Go bot. It runs
independently from `cmd/telesrv`, uses a transactional SQLite database, and keeps
the gramsrv OTP webhook authenticated and idempotent.

## Features

- required-channel membership gate;
- one free Russian or US number and paid anonymous `+888` numbers;
- login-code delivery to the number owner and explicitly authorized viewers;
- Premium, NexGram Stars, `+888` numbers and collectible username purchases;
- purchases for another NexGram account and three recent recipient IDs;
- Telegram Stars invoices with charge deduplication and a durable sales journal;
- daily/weekly weighted prize wheel;
- promo codes and button-based giveaway campaigns;
- owner mode with Stars, Premium and collectible username grants;
- owner-created invoices, refunds, broadcasts, code access and rate controls;
- owner-only recent sales journal.

All user-facing product text uses the NexGram name. Secrets are read only from
the service environment and must never be committed.

## Local run

Node.js 22.13 or newer is required because the bot uses `node:sqlite`.

```bash
cd cmd/bots/grammystore
cp .env.example .env
# Fill BOT_TOKEN, OWNER_IDS, GRAMSRV_TOKEN and CODE_WEBHOOK_SECRET.
npm ci
npm test
npm start
```

`OWNER_IDS` accepts comma-separated Telegram user IDs. `REQUIRED_CHANNEL` may
be empty to disable the subscription gate. `PRODUCT_NAME` defaults to
`NexGram`; deployment-specific values still belong in the environment.

## Database

The SQLite database stores users, numbers, OTP deliveries, pending multi-step
actions, payments, sales, refunds, recent recipients, wheel reservations,
promos and giveaways. Production should use:

```text
BOT_DB_PATH=/var/lib/telesrv-grammy-bot/bot.sqlite3
```

Stop the service before copying the database, or use SQLite's online backup
command. If a clean test launch is required, first back up all three files
(`bot.sqlite3`, `bot.sqlite3-wal`, `bot.sqlite3-shm`) and only then remove the
working copies while the service is stopped.

## Login-code webhook

Configure gramsrv as follows:

```text
TELESRV_PHONE_CODE_DELIVERY_PROVIDER=webhook
TELESRV_OTP_WEBHOOK_URL=http://127.0.0.1:2800/v1/otp/deliveries
TELESRV_OTP_WEBHOOK_SECRET=<same value as CODE_WEBHOOK_SECRET>
```

The bot verifies the gramsrv v1 HMAC signature, timestamp and idempotency key,
persists the delivery, immediately returns HTTP 202, and sends the Telegram
message asynchronously. This prevents Telegram Bot API latency from blocking
`auth.sendCode`. The listener is loopback-only by default. `GET /healthz` is a
read-only health endpoint.

## Linux installation

```bash
sudo useradd --system --home /var/lib/telesrv-grammy-bot --shell /usr/sbin/nologin telesrv-bot || true
sudo install -d -o telesrv-bot -g telesrv-bot -m 0750 /opt/telesrv-grammy-bot /var/lib/telesrv-grammy-bot
sudo cp -a package.json package-lock.json src /opt/telesrv-grammy-bot/
sudo chown -R telesrv-bot:telesrv-bot /opt/telesrv-grammy-bot /var/lib/telesrv-grammy-bot
cd /opt/telesrv-grammy-bot
sudo npm ci --omit=dev
sudo install -m 0600 .env.example /etc/telesrv-grammy-bot.env
# Fill the production secrets in /etc/telesrv-grammy-bot.env.
sudo install -m 0644 deploy/telesrv-grammy-bot.service /etc/systemd/system/telesrv-grammy-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now telesrv-grammy-bot
sudo systemctl status telesrv-grammy-bot --no-pager
sudo journalctl -u telesrv-grammy-bot -f
```

The bot unit can be updated and restarted independently. Updating this service
does not authorize updating or restarting the production `gramsrv` unit.
