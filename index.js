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

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1520582898850201740';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const EXTENSION_SECRET = process.env.EXTENSION_SECRET || 'changeme';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const DB_FILE = path.join(process.env.HOME || '.', 'music2dcord.db');

// ---- Database setup ----
let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_FILE)) {
    const fileBuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
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

  saveDb();
}

function saveDb() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  } catch (e) {
    console.error('Failed to save DB:', e.message);
  }
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ---- Middleware ----
app.use(cors({ origin: '*' }));
app.use(express.json());

// ---- OAuth Flow ----
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state: crypto.randomBytes(16).toString('hex'),
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(errorPage('Authorization cancelled.'));

  try {
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

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const { access_token, refresh_token, expires_in } = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) throw new Error('Failed to fetch user');
    const user = await userRes.json();

    dbRun(`
      INSERT INTO users (discord_id, username, access_token, refresh_token, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET
        username = excluded.username,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `, [user.id, user.username, access_token, refresh_token || null,
        Date.now() + (expires_in * 1000), Date.now()]);

    res.send(successPage(user.id, user.username));
  } catch (err) {
    console.error('OAuth error:', err);
    res.send(errorPage(err.message));
  }
});

// ---- Now Playing Update ----
app.post('/update', async (req, res) => {
  const { discord_id, secret, track } = req.body;
  if (secret !== EXTENSION_SECRET) return res.status(403).json({ error: 'Invalid secret' });
  if (!discord_id || !track) return res.status(400).json({ error: 'Missing fields' });

  const user = dbGet('SELECT * FROM users WHERE discord_id = ?', [discord_id]);
  if (!user) return res.status(404).json({ error: 'User not found — reconnect Discord' });

  try {
    let token = user.access_token;
    if (user.expires_at && Date.now() > user.expires_at - 60000) token = await doRefresh(user);

    const statusText = track.title && track.artist
      ? `🎵 ${track.title} — ${track.artist}`.slice(0, 128)
      : track.title ? `🎵 ${track.title}`.slice(0, 128) : null;

    if (!statusText) {
      await clearStatus(token);
      dbRun('UPDATE users SET last_track = NULL, updated_at = ? WHERE discord_id = ?', [Date.now(), discord_id]);
      return res.json({ ok: true, cleared: true });
    }

    if (user.last_track === statusText) return res.json({ ok: true, unchanged: true });

    await setStatus(token, statusText);
    dbRun('UPDATE users SET last_track = ?, updated_at = ? WHERE discord_id = ?', [statusText, Date.now(), discord_id]);
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
  const user = dbGet('SELECT * FROM users WHERE discord_id = ?', [discord_id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    let token = user.access_token;
    if (user.expires_at && Date.now() > user.expires_at - 60000) token = await doRefresh(user);
    await clearStatus(token);
    dbRun('UPDATE users SET last_track = NULL WHERE discord_id = ?', [discord_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Disconnect ----
app.post('/disconnect', (req, res) => {
  const { discord_id, secret } = req.body;
  if (secret !== EXTENSION_SECRET) return res.status(403).json({ error: 'Invalid secret' });
  dbRun('DELETE FROM users WHERE discord_id = ?', [discord_id]);
  res.json({ ok: true });
});

// ---- Health check ----
app.get('/health', (_req, res) => {
  const row = dbGet('SELECT COUNT(*) as n FROM users');
  res.json({ ok: true, users: row ? row.n : 0 });
});

// ---- Discord API helpers ----
async function setStatus(accessToken, text) {
  const res = await fetch('https://discord.com/api/v10/users/@me/settings', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_status: { text, emoji_name: null } }),
  });
  if (!res.ok) throw new Error(`setStatus failed ${res.status}: ${await res.text().then(t => t.slice(0,200))}`);
}

async function clearStatus(accessToken) {
  const res = await fetch('https://discord.com/api/v10/users/@me/settings', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_status: null }),
  });
  if (!res.ok) throw new Error(`clearStatus failed ${res.status}`);
}

async function doRefresh(user) {
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
  dbRun('UPDATE users SET access_token = ?, refresh_token = ?, expires_at = ? WHERE discord_id = ?',
    [data.access_token, data.refresh_token || user.refresh_token, Date.now() + (data.expires_in * 1000), user.discord_id]);
  return data.access_token;
}

// ---- HTML helpers ----
function successPage(discordId, username) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Connected!</title>
  <style>body{font-family:system-ui;background:#0f0f14;color:#e8e8ed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;}h1{color:#7c5bf5;}p{color:#8888a0;text-align:center;}</style></head>
  <body><h1>✅ Connected!</h1><p>Welcome, <strong>${username}</strong>!<br>Your Discord status will now update when you play music.<br>You can close this tab.</p>
  <script>if(window.opener){window.opener.postMessage({type:'MUSIC2DCORD_AUTH',discord_id:'${discordId}',username:'${username}'},'*');setTimeout(()=>window.close(),2000);}</script></body></html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title>
  <style>body{font-family:system-ui;background:#0f0f14;color:#e8e8ed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;}h1{color:#f04747;}p{color:#8888a0;}</style></head>
  <body><h1>❌ Error</h1><p>${msg}</p></body></html>`;
}

// ---- Start ----
initDb().then(() => {
  app.listen(PORT, () => console.log(`Music2Dcord server on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
