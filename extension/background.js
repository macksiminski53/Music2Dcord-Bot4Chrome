// extension/background.js
// Service worker — manages connection state, receives track updates
// from content scripts, and forwards them to the Music2Dcord server.

const SERVER_URL = 'https://music2dcord-bot4chrome-production.up.railway.app';
const EXTENSION_SECRET = 'changeme'; // TODO: match EXTENSION_SECRET env var on Railway
const UPDATE_INTERVAL_MS = 15000; // how often to push to server even if track hasn't changed

let currentTrack = null;
let discordId = null;
let username = null;
let lastPushKey = null;
let lastPushTime = 0;

// ---- Load saved auth on startup ----
chrome.storage.local.get(['discordId', 'username'], (data) => {
  discordId = data.discordId || null;
  username = data.username || null;
});

// ---- Message handler ----
// Receives TRACK_UPDATE from content scripts and AUTH_SUCCESS from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TRACK_UPDATE') {
    handleTrackUpdate(msg.track);
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_STATE') {
    sendResponse({ discordId, username, currentTrack });
  }

  if (msg.type === 'AUTH_SUCCESS') {
    discordId = msg.discord_id;
    username = msg.username;
    chrome.storage.local.set({ discordId, username });
    sendResponse({ ok: true });
  }

  if (msg.type === 'DISCONNECT') {
    disconnect();
    sendResponse({ ok: true });
  }

  return true; // keep message channel open for async
});

// ---- Track update logic ----
async function handleTrackUpdate(track) {
  currentTrack = track;

  if (!discordId) return; // not connected yet

  const key = track ? `${track.title}|${track.artist}` : 'none';
  const now = Date.now();
  const trackChanged = key !== lastPushKey;
  const timerElapsed = now - lastPushTime > UPDATE_INTERVAL_MS;

  if (!trackChanged && !timerElapsed) return;

  lastPushKey = key;
  lastPushTime = now;

  try {
    const endpoint = track ? `${SERVER_URL}/update` : `${SERVER_URL}/clear`;
    const body = track
      ? { discord_id: discordId, secret: EXTENSION_SECRET, track }
      : { discord_id: discordId, secret: EXTENSION_SECRET };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn('Music2Dcord update failed:', data.error || res.status);
    }
  } catch (err) {
    console.warn('Music2Dcord network error:', err.message);
  }
}

// ---- Alarm for periodic refresh ----
// Keeps the status alive even if no track change event fires
chrome.alarms.create('refresh', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh' && currentTrack) {
    lastPushTime = 0; // force a push on next track update
  }
});

// ---- Disconnect ----
async function disconnect() {
  if (discordId) {
    await fetch(`${SERVER_URL}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discord_id: discordId, secret: EXTENSION_SECRET }),
    }).catch(() => {});
  }
  discordId = null;
  username = null;
  currentTrack = null;
  lastPushKey = null;
  chrome.storage.local.remove(['discordId', 'username']);
}
