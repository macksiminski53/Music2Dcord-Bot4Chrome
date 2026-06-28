// extension/popup.js
const SERVER_URL = 'https://your-app.up.railway.app'; // TODO: replace after Railway deploy

const elLoading = document.getElementById('state-loading');
const elDisconnected = document.getElementById('state-disconnected');
const elConnected = document.getElementById('state-connected');
const elBtnConnect = document.getElementById('btn-connect');
const elBtnDisconnect = document.getElementById('btn-disconnect');
const elUsernameLabel = document.getElementById('username-label');
const elNpLabel = document.getElementById('np-label');
const elNpTitle = document.getElementById('np-title');
const elNpArtist = document.getElementById('np-artist');
const elNpSource = document.getElementById('np-source');

function showState(state) {
  elLoading.style.display = state === 'loading' ? 'block' : 'none';
  elDisconnected.style.display = state === 'disconnected' ? 'block' : 'none';
  elConnected.style.display = state === 'connected' ? 'block' : 'none';
}

function formatSource(hostname) {
  if (!hostname) return '';
  if (hostname.includes('youtube')) return 'YouTube Music';
  if (hostname.includes('spotify')) return 'Spotify';
  if (hostname.includes('apple')) return 'Apple Music';
  if (hostname.includes('soundcloud')) return 'SoundCloud';
  if (hostname.includes('tidal')) return 'Tidal';
  return hostname;
}

async function loadState() {
  showState('loading');
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });

  if (!state.discordId) {
    showState('disconnected');
    return;
  }

  elUsernameLabel.textContent = state.username || state.discordId;
  showState('connected');

  if (state.currentTrack) {
    elNpLabel.textContent = 'Now playing';
    elNpLabel.className = 'np-label';
    elNpTitle.textContent = state.currentTrack.title || 'Unknown';
    elNpArtist.textContent = state.currentTrack.artist || '';
    elNpSource.textContent = `via ${formatSource(state.currentTrack.source)}`;
  } else {
    elNpLabel.textContent = 'Nothing detected';
    elNpLabel.className = 'np-label idle';
    elNpTitle.textContent = 'Play music in a supported tab';
    elNpArtist.textContent = '';
    elNpSource.textContent = '';
  }
}

// Connect button — opens OAuth popup window
elBtnConnect.addEventListener('click', () => {
  const authUrl = `${SERVER_URL}/auth/login`;
  const win = window.open(authUrl, 'music2dcord-auth', 'width=480,height=700');

  // Listen for the success message from the auth callback page
  window.addEventListener('message', async (event) => {
    if (event.data?.type !== 'MUSIC2DCORD_AUTH') return;
    await chrome.runtime.sendMessage({
      type: 'AUTH_SUCCESS',
      discord_id: event.data.discord_id,
      username: event.data.username,
    });
    if (win && !win.closed) win.close();
    loadState();
  }, { once: true });
});

// Disconnect button
elBtnDisconnect.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' });
  showState('disconnected');
});

loadState();
