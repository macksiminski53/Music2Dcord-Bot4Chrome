# Music2Dcord-Bot4Chrome

Shows what you're listening to in your Discord status — works in Chrome/ChromeOS with YouTube Music, Spotify Web, Apple Music, SoundCloud, and Tidal.

## How it works

1. A Chrome extension reads what's playing via the browser's Media Session API
2. It sends the track info to a small backend server (hosted on Railway)
3. The server updates your Discord custom status via OAuth

## Setup (for developers / server owners)

### 1. Discord app setup

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Open your app → **OAuth2**
3. Add redirect URI: `https://YOUR-RAILWAY-URL.up.railway.app/auth/callback`
4. Scopes needed: `identify`, `connections`
5. Copy your **Client ID**, **Client Secret**, and **Bot Token**

### 2. Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Select this repo
4. Add these environment variables:

| Variable | Value |
|---|---|
| `DISCORD_CLIENT_ID` | Your Discord app Client ID |
| `DISCORD_CLIENT_SECRET` | Your Discord app Client Secret |
| `DISCORD_BOT_TOKEN` | Your bot token |
| `BASE_URL` | Your Railway app URL (e.g. `https://myapp.up.railway.app`) |
| `EXTENSION_SECRET` | Any random string (e.g. generate with `openssl rand -hex 32`) |

5. Railway will deploy automatically

### 3. Update the extension

Once you have your Railway URL, update two files:

**`extension/background.js`** line 4:
```js
const SERVER_URL = 'https://YOUR-APP.up.railway.app';
const EXTENSION_SECRET = 'your-extension-secret'; // same as Railway env var
```

**`extension/popup.js`** line 1:
```js
const SERVER_URL = 'https://YOUR-APP.up.railway.app';
```

### 4. Load the extension

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 5. Connect your Discord

1. Click the Music2Dcord icon in Chrome
2. Click **Connect Discord**
3. Authorize the app
4. Play music in a supported tab — your Discord status updates automatically

## Supported music services

- YouTube Music
- Spotify Web Player
- Apple Music (web)
- SoundCloud
- Tidal

## Publishing to Chrome Web Store

Once tested, you can publish the `extension/` folder to the Chrome Web Store for easy installation by users.

## License

MIT
