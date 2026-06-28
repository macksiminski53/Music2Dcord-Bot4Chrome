// extension/content.js
// Runs inside music tabs (YouTube Music, Spotify, etc.)
// Reads the Media Session API and sends track info to the background worker.

(function () {
  let lastSent = null;
  let sendTimer = null;

  function getTrack() {
    const ms = navigator.mediaSession;
    if (!ms || !ms.metadata) return null;

    const { title, artist, album, artwork } = ms.metadata;
    const state = ms.playbackState; // 'playing' | 'paused' | 'none'

    if (!title) return null;

    return {
      title: title || null,
      artist: artist || null,
      album: album || null,
      artworkUrl: artwork && artwork.length > 0 ? artwork[artwork.length - 1].src : null,
      state,
      source: location.hostname,
    };
  }

  function maybeReport() {
    const track = getTrack();
    const key = track ? `${track.title}|${track.artist}|${track.state}` : 'none';

    if (key === lastSent) return; // nothing changed
    lastSent = key;

    chrome.runtime.sendMessage({
      type: 'TRACK_UPDATE',
      track: track && track.state === 'playing' ? track : null,
    }).catch(() => {}); // background may not be ready yet, safe to ignore
  }

  // Poll every 5 seconds — Media Session doesn't have change events
  sendTimer = setInterval(maybeReport, 5000);
  maybeReport(); // run immediately on load

  // Also watch for visibility changes (tab switch, focus)
  document.addEventListener('visibilitychange', maybeReport);
})();
