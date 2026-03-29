// ── DMH Multi-Source Player ───────────────────────────────────────────────────
// Handles Spotify SDK, YouTube IFrame API, and HTML5 Audio for local files.
// Only the HOST drives actual playback. Guests mirror the state visually.

window.DMHPlayer = (function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _isHost = false;
  let _spotifyPlayer = null;
  let _spotifyDeviceId = null;
  let _spotifyToken = null;
  let _ytPlayer = null;
  let _ytReady = false;
  let _localAudio = null;
  let _currentSource = null; // 'spotify' | 'youtube' | 'local'
  let _currentTrack = null;
  let _isPlaying = false;
  let _progressInterval = null;

  // Callbacks set by session.js
  let _onProgress = null;
  let _onEnded = null;
  let _onReady = null;

  // ── Init ──────────────────────────────────────────────────────────────────
  function init({ isHost, spotifyToken, onProgress, onEnded, onReady }) {
    _isHost = isHost;
    _spotifyToken = spotifyToken || null;
    _onProgress = onProgress || (() => {});
    _onEnded = onEnded || (() => {});
    _onReady = onReady || (() => {});

    _initLocalAudio();

    if (_isHost) {
      if (_spotifyToken) _initSpotify();
      _initYouTube();
    }
  }

  function setSpotifyToken(token) {
    _spotifyToken = token;
    if (_isHost && !_spotifyPlayer) {
      _initSpotify();
    } else if (_spotifyPlayer && token) {
      // Re-connect isn't straightforward; the SDK auto-renews if we call getOAuthToken
    }
  }

  // ── Spotify Web Playback SDK ──────────────────────────────────────────────
  function _initSpotify() {
    if (window.Spotify && window.Spotify.Player) {
      _createSpotifyPlayer();
      return;
    }
    // Load SDK
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    document.body.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = () => {
      _createSpotifyPlayer();
    };
  }

  function _createSpotifyPlayer() {
    _spotifyPlayer = new window.Spotify.Player({
      name: 'DemonicMusicHost',
      getOAuthToken: (cb) => {
        // Token may have been refreshed; grab latest
        cb(_spotifyToken);
      },
      volume: 0.8
    });

    _spotifyPlayer.addListener('ready', ({ device_id }) => {
      _spotifyDeviceId = device_id;
      console.log('[Player] Spotify ready, device:', device_id);
      _onReady && _onReady('spotify', device_id);
    });

    _spotifyPlayer.addListener('not_ready', ({ device_id }) => {
      console.warn('[Player] Spotify device offline:', device_id);
    });

    _spotifyPlayer.addListener('player_state_changed', (state) => {
      if (!state) return;
      // Detect natural track end
      if (state.paused && state.position === 0 && state.track_window?.previous_tracks?.length > 0) {
        _handleEnded();
      }
    });

    _spotifyPlayer.addListener('account_error', () => {
      console.error('[Player] Spotify Premium required');
      window.DMHToast && window.DMHToast.error('Spotify Premium erforderlich für Wiedergabe.');
    });

    _spotifyPlayer.connect().then(success => {
      if (!success) console.error('[Player] Spotify connect failed');
    });
  }

  // ── YouTube IFrame API ────────────────────────────────────────────────────
  function _initYouTube() {
    const container = document.getElementById('ytPlayerContainer');
    if (!container) return;

    if (window.YT && window.YT.Player) {
      _createYTPlayer();
      return;
    }

    // Load YT IFrame API
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);

    window.onYouTubeIframeAPIReady = () => {
      _createYTPlayer();
    };
  }

  function _createYTPlayer() {
    const div = document.createElement('div');
    div.id = 'ytIframePlayer';
    document.getElementById('ytPlayerContainer').appendChild(div);

    _ytPlayer = new window.YT.Player('ytIframePlayer', {
      width: '1',
      height: '1',
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        iv_load_policy: 3,
        modestbranding: 1,
        rel: 0,
        playsinline: 1
      },
      events: {
        onReady: () => {
          _ytReady = true;
          console.log('[Player] YouTube ready');
        },
        onStateChange: (event) => {
          if (event.data === window.YT.PlayerState.ENDED) {
            _handleEnded();
          }
        },
        onError: (event) => {
          console.error('[Player] YouTube error:', event.data);
          window.DMHToast && window.DMHToast.error('YouTube-Fehler: Track übersprungen.');
          _handleEnded();
        }
      }
    });
  }

  // ── Local Audio ───────────────────────────────────────────────────────────
  function _initLocalAudio() {
    _localAudio = new Audio();
    _localAudio.preload = 'metadata';
    _localAudio.addEventListener('ended', _handleEnded);
    _localAudio.addEventListener('error', (e) => {
      console.error('[Player] Local audio error:', e);
      window.DMHToast && window.DMHToast.error('Audiodatei konnte nicht abgespielt werden.');
    });
  }

  // ── Play a track ──────────────────────────────────────────────────────────
  async function play(track, positionMs = 0) {
    if (!_isHost) return;

    // Stop whatever is currently playing
    await _stopCurrent();

    _currentTrack = track;
    _currentSource = track.source;
    _isPlaying = true;

    switch (track.source) {
      case 'spotify':
        await _playSpotify(track, positionMs);
        break;
      case 'youtube':
        _playYouTube(track, positionMs);
        break;
      case 'local':
        _playLocal(track, positionMs);
        break;
    }

    _startProgressBroadcast();
  }

  async function _playSpotify(track, positionMs) {
    if (!_spotifyToken || !_spotifyDeviceId) {
      window.DMHToast && window.DMHToast.error('Spotify nicht verbunden. Bitte zuerst Spotify verbinden.');
      return;
    }
    try {
      await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${_spotifyDeviceId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${_spotifyToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          uris: [track.spotifyUri],
          position_ms: positionMs
        })
      });
    } catch (err) {
      console.error('[Player] Spotify play error:', err);
    }
  }

  function _playYouTube(track, positionMs) {
    if (!_ytReady || !_ytPlayer) {
      // Queue it for when YT is ready
      const check = setInterval(() => {
        if (_ytReady && _ytPlayer) {
          clearInterval(check);
          _ytPlayer.loadVideoById({ videoId: track.youtubeId, startSeconds: positionMs / 1000 });
          _ytPlayer.playVideo();
        }
      }, 200);
      return;
    }
    _ytPlayer.loadVideoById({ videoId: track.youtubeId, startSeconds: positionMs / 1000 });
    _ytPlayer.playVideo();
  }

  function _playLocal(track, positionMs) {
    _localAudio.src = `/upload/stream/${encodeURIComponent(track.localFileId)}`;
    _localAudio.load();
    _localAudio.currentTime = positionMs / 1000;
    _localAudio.play().catch(err => {
      console.error('[Player] Local play error:', err);
    });
  }

  // ── Pause ─────────────────────────────────────────────────────────────────
  async function pause() {
    if (!_isHost) return;
    _isPlaying = false;
    _stopProgressBroadcast();

    switch (_currentSource) {
      case 'spotify':
        if (_spotifyPlayer) await _spotifyPlayer.pause();
        break;
      case 'youtube':
        if (_ytPlayer && _ytReady) _ytPlayer.pauseVideo();
        break;
      case 'local':
        _localAudio.pause();
        break;
    }
  }

  // ── Resume ────────────────────────────────────────────────────────────────
  async function resume() {
    if (!_isHost) return;
    _isPlaying = true;

    switch (_currentSource) {
      case 'spotify':
        if (_spotifyPlayer) await _spotifyPlayer.resume();
        break;
      case 'youtube':
        if (_ytPlayer && _ytReady) _ytPlayer.playVideo();
        break;
      case 'local':
        _localAudio.play().catch(console.error);
        break;
    }

    _startProgressBroadcast();
  }

  // ── Seek ──────────────────────────────────────────────────────────────────
  async function seek(positionMs) {
    if (!_isHost) return;

    switch (_currentSource) {
      case 'spotify':
        if (_spotifyPlayer) await _spotifyPlayer.seek(positionMs);
        break;
      case 'youtube':
        if (_ytPlayer && _ytReady) _ytPlayer.seekTo(positionMs / 1000, true);
        break;
      case 'local':
        _localAudio.currentTime = positionMs / 1000;
        break;
    }
  }

  // ── Stop ──────────────────────────────────────────────────────────────────
  async function _stopCurrent() {
    _stopProgressBroadcast();
    _isPlaying = false;

    if (_currentSource === 'spotify' && _spotifyPlayer) {
      try { await _spotifyPlayer.pause(); } catch (_) {}
    }
    if (_currentSource === 'youtube' && _ytPlayer && _ytReady) {
      try { _ytPlayer.stopVideo(); } catch (_) {}
    }
    if (_currentSource === 'local') {
      _localAudio.pause();
      _localAudio.src = '';
    }
  }

  // ── Progress ──────────────────────────────────────────────────────────────
  function _startProgressBroadcast() {
    _stopProgressBroadcast();
    if (!_isHost) return;
    _progressInterval = setInterval(async () => {
      const pos = await getCurrentPosition();
      if (pos !== null) _onProgress(pos);
    }, 1500);
  }

  function _stopProgressBroadcast() {
    if (_progressInterval) {
      clearInterval(_progressInterval);
      _progressInterval = null;
    }
  }

  async function getCurrentPosition() {
    try {
      switch (_currentSource) {
        case 'spotify':
          if (_spotifyPlayer) {
            const state = await _spotifyPlayer.getCurrentState();
            return state ? state.position : null;
          }
          break;
        case 'youtube':
          if (_ytPlayer && _ytReady) {
            return Math.floor(_ytPlayer.getCurrentTime() * 1000);
          }
          break;
        case 'local':
          return Math.floor(_localAudio.currentTime * 1000);
      }
    } catch (_) {}
    return null;
  }

  function _handleEnded() {
    _isPlaying = false;
    _stopProgressBroadcast();
    _onEnded && _onEnded();
  }

  // ── Volume (local + YouTube) ──────────────────────────────────────────────
  function setVolume(vol) { // 0–1
    if (_localAudio) _localAudio.volume = vol;
    if (_ytPlayer && _ytReady) _ytPlayer.setVolume(vol * 100);
    if (_spotifyPlayer) _spotifyPlayer.setVolume(vol).catch(() => {});
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    init,
    setSpotifyToken,
    play,
    pause,
    resume,
    seek,
    setVolume,
    getCurrentPosition,
    isSpotifyReady: () => !!_spotifyDeviceId,
    isYTReady: () => _ytReady,
    get spotifyDeviceId() { return _spotifyDeviceId; }
  };
})();
