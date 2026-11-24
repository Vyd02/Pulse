# Pulse

24/7 crypto and stock alerts on your phone: breaking news, rumors, Asia/China headlines, whale moves, price spikes, market bells and earnings, plus AI briefings that explain what each story means for your positions, daily lessons and a paper-trading practice account.

**Layout:** `server/` is the Cloudflare Worker (feeds, alerts, briefings, paper trading) and also hosts the app's screens at `/app/` (`server/public/app/index.html`), so screen updates ship with `wrangler deploy` and no new APK. `android/` is the thin native shell (WebView, background alert service, notifications); `android/assets/index.html` is the offline fallback copy of the same screen. The APK signing key is not in this repo.

**How it works:** a free Cloudflare server checks 15 sources every minute, around the clock, even while your phone is asleep. When it finds something new, it pushes it straight to the Pulse app over a live connection.

| Type | Sources |
|---|---|
| 🔥 Breaking & rumors | Watcher Guru, unfolded., PhoenixNews, Cointelegraph Flash |
| 🌏 Asia & China | Wu Blockchain, Binance announcements, OKX announcements |
| 🐋 Whale moves | Whale Alert (only transfers over your minimum, $25M by default) |
| 📰 Major news | CoinDesk, Cointelegraph, The Block, Decrypt, Blockworks, CryptoSlate, Bitcoin Magazine |
| 📈 Price alerts | Your watchlist; pings when a coin moves X% within Y minutes |

Live prices in the app come straight from Coinbase.

---

## Setup (about 10 minutes, all from your phone)

### 1. Cloudflare (free)
1. Sign up at **dash.cloudflare.com**.
2. Open **Workers & Pages** once. If it asks you to pick a `workers.dev` subdomain, pick one. This becomes part of your server address.
3. Copy your **Account ID**. It's on the right side of the Workers & Pages overview page.
4. Go to **My Profile → API Tokens → Create Token**, choose the **Edit Cloudflare Workers** template, then **Continue → Create Token**. Copy the token. Cloudflare only shows it once.

### 2. GitHub secrets
In this repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add these three:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1.4 |
| `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 1.3 |
| `APP_KEY` | a long password you make up. The app uses it to prove it's you. |

### 3. Deploy the server
Go to **Actions → Deploy Pulse server → Run workflow**. When the run turns green, open it. The summary shows your server address, something like `https://pulse.yourname.workers.dev`.

Later changes to the `server/` folder redeploy automatically.

### 4. Install the app
1. Install `Pulse.apk`.
2. Open it, paste the server address and your `APP_KEY`, then tap **Connect**.
3. Allow notifications.
4. In Settings, tap **Fix** next to "Let Pulse run in the background". Without this, Android may cut the live connection when the phone sleeps.

On the first minute, Pulse loads recent stories quietly. After that, you only get pinged for new ones.

---

## Tuning it
Everything is in the app's ⚙️ Settings:
- **Your coins:** add or remove coins for price alerts and the ⭐ filter
- **Price alert:** how big a move (0.5–10%) and over what time (5 min to 4 hours)
- **Whale minimum:** $10M / $25M / $50M / $100M
- **Notify me about:** turn each type on or off, or only get stories about your coins
- **Sources:** a green or red light for each source, so you can see if one stopped working

You can set a different sound or vibration for each type under **Sounds & vibration per type**.

## Costs
Everything runs on Cloudflare's free plan. Pulse uses roughly 1,500 server runs and a few thousand requests a day, well under the free limits.

## Building the app yourself
`android/build.sh` builds the APK with the Android SDK (platform 34, build-tools 35). It doesn't need Gradle.

> Pulse shows news, rumors and price moves. It doesn't tell you what to buy or sell, and rumors are unconfirmed.
