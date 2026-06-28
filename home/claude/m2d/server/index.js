// server/index.js
// Music2Dcord-Bot4Chrome backend
// Handles Discord OAuth, stores user tokens, and updates Discord status
// when the Chrome extension sends now-playing info.
//
// Required environment variables (set on Railway):
//   DISCORD_CLIENT_ID     — from discord.com/developers/applications
//   DISCORD_CLIENT_SECRET — from discord.com/developers/applications
//   DISCORD_BOT_TOKEN     — from Bot section of your Discord app
//   BASE_URL              — your Railway app URL e.g. https://myapp.up.railway.app
//   EXTENSION_SECRET      — any random string, shared with the extension
//                           to prevent random people hitting your /update endpoint

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1520582898850201740';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const EXTENSION_SECRET = process.env.EXTENSION_SECRET || 'changeme';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

// ---- Database ----
// Stores one row per user: their Discord user ID, username, and
// access token so we can update their status.
const db = new Database(path.join(process.env.HOME || '.', 'music2dcord.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_id    TEXT PRIMARY KEY,
    username      TEXT,
    access_token  TEXT,
    refresh_token TEXT,
    expires_at    INTEGER,
    last_track    TEXT,
    updated_at    INTEGER
  )
`);

// ---- Middleware ----
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- OAuth Flow ----
// Step 1: redirect user to Discord to authorize
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify connections',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// Step 2: Discord redirects back here with a code
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.send(errorPage('Authorization cancelled or failed. You can close this tab.'));
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_in } = tokenData;

    // Fetch user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userRes.ok) throw new Error('Failed to fetch user info');
    const user = await userRes.json();

    // Save to DB
    db.prepare(`
      INSERT INTO users (discord_id, username, access_token, refresh_token, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET
        username = excluded.username,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      user.id,
      user.username,
      access_token,
      refresh_token || null,
      Date.now() + (expires_in * 1000),
      Date.now()
    );

    // Return a page that tells the extension the user ID
    res.send(successPage(user.id, user.username));
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.send(errorPage(`Something went wrong: ${err.message}`));
  }
});

// ---- Now Playing Update ----
// Called by the Chrome extension with current track info.
// Requires the user's Discord ID and the shared EXTENSION_SECRET.
app.post('/update', async (req, res) => {
  const { discord_id, secret, track } = req.body;

  if (secret !== EXTENSION_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  if (!discord_id || !track) {
    return res.status(400).json({ error: 'Missing discord_id or track' });
  }

  const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discord_id);
  if (!user) {
    return res.status(404).json({ error: 'User not found — please reconnect Discord' });
  }

  try {
    // Refresh token if expired
    let accessToken = user.access_token;
    if (user.expires_at && Date.now() > user.expires_at - 60000) {
      accessToken = await refreshToken(user);
    }

    // Build status text
    const statusText = track.title && track.artist
      ? `🎵 ${track.title} — ${track.artist}`
      : track.title
      ? `🎵 ${track.title}`
      : null;

    if (!statusText) {
      // Nothing playing — clear status
      await clearStatus(accessToken);
      db.prepare('UPDATE users SET last_track = NULL, updated_at = ? WHERE discord_id = ?')
        .run(Date.now(), discord_id);
      return res.json({ ok: true, cleared: true });
    }

    // Only update if track actually changed
    if (user.last_track === statusText) {
      return res.json({ ok: true, unchanged: true });
    }

    await setStatus(accessToken, statusText);
    db.prepare('UPDATE users SET last_track = ?, updated_at = ? WHERE discord_id = ?')
      .run(statusText, Date.now(), discord_id);

    res.json({ ok: true, status: statusText });
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Clear status ----
app.post('/clear', async (req, res) => {
  const { discord_id, secret } = req.body;
  if (secret !== EXTENSION_SECRET) return res.status(403).json({ error: 'Invalid secret' });

  const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discord_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    let accessToken = user.access_token;
    if (user.expires_at && Date.now() > user.expires_at - 60000) {
      accessToken = await refreshToken(user);
    }
    await clearStatus(accessToken);
    db.prepare('UPDATE users SET last_track = NULL WHERE discord_id = ?').run(discord_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Disconnect ----
app.post('/disconnect', (req, res) => {
  const { discord_id, secret } = req.body;
  if (secret !== EXTENSION_SECRET) return res.status(403).json({ error: 'Invalid secret' });
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(discord_id);
  res.json({ ok: true });
});

// ---- Health check ----
app.get('/health', (_req, res) => res.json({ ok: true, users: db.prepare('SELECT COUNT(*) as n FROM users').get().n }));

// ---- Discord API helpers ----
async function setStatus(accessToken, text) {
  // Discord's custom status endpoint via user OAuth token
  const res = await fetch('https://discord.com/api/v10/users/@me/settings', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      custom_status: {
        text: text.slice(0, 128), // Discord's limit
        emoji_name: null,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord setStatus failed ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function clearStatus(accessToken) {
  const res = await fetch('https://discord.com/api/v10/users/@me/settings', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ custom_status: null }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord clearStatus failed ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function refreshToken(user) {
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  db.prepare('UPDATE users SET access_token = ?, refresh_token = ?, expires_at = ? WHERE discord_id = ?')
    .run(data.access_token, data.refresh_token || user.refresh_token, Date.now() + (data.expires_in * 1000), user.discord_id);
  return data.access_token;
}

// ---- HTML helpers ----
function successPage(discordId, username) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Connected!</title>
  <style>body{font-family:system-ui;background:#0f0f14;color:#e8e8ed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;}
  h1{color:#7c5bf5;}p{color:#8888a0;text-align:center;}code{background:#1e1e2a;padding:2px 8px;border-radius:6px;}</style></head>
  <body><h1>✅ Connected!</h1><p>Welcome, <strong>${username}</strong>!<br>Your Discord status will now update when you play music.<br>You can close this tab.</p>
  <script>
    // Tell the extension the connection succeeded
    if (window.opener) {
      window.opener.postMessage({ type: 'MUSIC2DCORD_AUTH', discord_id: '${discordId}', username: '${username}' }, '*');
      setTimeout(() => window.close(), 2000);
    }
  </script></body></html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title>
  <style>body{font-family:system-ui;background:#0f0f14;color:#e8e8ed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;}
  h1{color:#f04747;}p{color:#8888a0;text-align:center;}</style></head>
  <body><h1>❌ Something went wrong</h1><p>${msg}</p></body></html>`;
}

app.listen(PORT, () => console.log(`Music2Dcord server running on port ${PORT}`));
