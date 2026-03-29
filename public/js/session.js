// ── DMH Session Page ──────────────────────────────────────────────────────────
(function () {
  'use strict';

  // ── URL params ────────────────────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const MODE_CREATE  = params.get('create') === '1';
  const MODE_JOIN    = params.get('join');
  const MODE_REJOIN  = params.get('sessionId'); // back from Spotify OAuth inside a session
  const USERNAME     = params.get('username')
    || sessionStorage.getItem('dmh_username')
    || 'Anonymous';
  const SPOTIFY_TOKEN   = params.get('spotify_token')
    || (isSpotifyValid() ? sessionStorage.getItem('dmh_spotify_token') : null);
  const SPOTIFY_REFRESH = params.get('spotify_refresh')
    || sessionStorage.getItem('dmh_spotify_refresh') || null;
  const SPOTIFY_EXPIRES = parseInt(params.get('spotify_expires')
    || sessionStorage.getItem('dmh_spotify_expires') || '0', 10);
  const SPOTIFY_ERROR   = params.get('spotify_error');

  // Persist new tokens to sessionStorage if they came via URL
  if (params.get('spotify_token')) {
    sessionStorage.setItem('dmh_spotify_token',   params.get('spotify_token'));
    sessionStorage.setItem('dmh_spotify_refresh', params.get('spotify_refresh') || '');
    sessionStorage.setItem('dmh_spotify_expires', params.get('spotify_expires') || '0');
  }

  function isSpotifyValid() {
    const token   = sessionStorage.getItem('dmh_spotify_token');
    const expires = parseInt(sessionStorage.getItem('dmh_spotify_expires') || '0', 10);
    return !!token && (expires === 0 || expires > Date.now() + 60000);
  }

  // Clean URL (remove tokens from history)
  window.history.replaceState({}, '', window.location.pathname);

  // ── State ─────────────────────────────────────────────────────────────────
  let sessionId = null;
  let isHost = false;
  let queue = [];
  let currentTrackIndex = -1;
  let isPlaying = false;
  let spotifyToken = SPOTIFY_TOKEN || null;
  let spotifyRefresh = SPOTIFY_REFRESH || null;
  let spotifyExpires = SPOTIFY_EXPIRES || 0;
  let spotifyRefreshTimer = null;
  let progressUpdateTimer = null;
  let guestProgressMs = 0;        // guest-side estimated current position
  let guestProgressTimestamp = 0;

  // Drag-and-drop state
  let dragFromIndex = null;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const headerSessionCode = document.getElementById('headerSessionCode');
  const copyCodeBtn       = document.getElementById('copyCodeBtn');
  const participantCount  = document.getElementById('participantCount');
  const hostBadge         = document.getElementById('hostBadge');
  const spotifyStatusEl   = document.getElementById('spotifyStatus');
  const spotifyStatusText = document.getElementById('spotifyStatusText');

  const npThumbnail   = document.getElementById('npThumbnail');
  const npSourceBadge = document.getElementById('npSourceBadge');
  const npTitle       = document.getElementById('npTitle');
  const npArtist      = document.getElementById('npArtist');
  const npAlbum       = document.getElementById('npAlbum');
  const npAddedBy     = document.getElementById('npAddedBy');
  const progressFill  = document.getElementById('progressFill');
  const progressThumb = document.getElementById('progressThumb');
  const progressCurrent = document.getElementById('progressCurrent');
  const progressTotal   = document.getElementById('progressTotal');
  const progressBarWrap = document.getElementById('progressBarWrap');

  const playbackControls = document.getElementById('playbackControls');
  const guestControls    = document.getElementById('guestControls');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const btnPrev      = document.getElementById('btnPrev');
  const btnNext      = document.getElementById('btnNext');
  const iconPlay     = document.getElementById('iconPlay');
  const iconPause    = document.getElementById('iconPause');

  const spotifyConnectArea = document.getElementById('spotifyConnect');
  const btnSpotifyConnect  = document.getElementById('btnSpotifyConnect');
  const hostSettings       = document.getElementById('hostSettings');
  const toggleAllowJoin    = document.getElementById('toggleAllowJoin');
  const toggleAllowAdd     = document.getElementById('toggleAllowAdd');

  const queueList   = document.getElementById('queueList');
  const queueEmpty  = document.getElementById('queueEmpty');
  const btnAddSong  = document.getElementById('btnAddSong');

  const localFileInput    = document.getElementById('localFileInput');
  const uploadProgress    = document.getElementById('uploadProgress');
  const uploadProgressBar = document.getElementById('uploadProgressBar');
  const uploadProgressText= document.getElementById('uploadProgressText');

  const participantList = document.getElementById('participantList');
  const participantsBadge = document.getElementById('participantsBadge');

  const participantsModal      = document.getElementById('participantsModal');
  const participantsModalClose = document.getElementById('participantsModalClose');
  const participantsModalList  = document.getElementById('participantsModalList');
  const participantsModalBackdrop = document.getElementById('participantsModalBackdrop');

  // ── Socket.io ─────────────────────────────────────────────────────────────
  const socket = io();

  socket.on('connect', () => {
    console.log('[Session] Connected');
    if (MODE_CREATE) {
      socket.emit('create_session', { username: USERNAME });
    } else if (MODE_JOIN) {
      socket.emit('join_session', { sessionId: MODE_JOIN, username: USERNAME });
    } else if (MODE_REJOIN) {
      // Returning from Spotify OAuth — rejoin the existing session
      socket.emit('join_session', { sessionId: MODE_REJOIN, username: USERNAME });
    } else {
      window.location.href = '/';
    }
  });

  socket.on('disconnect', () => {
    toast('Verbindung getrennt. Verbinde erneut…', 'info');
  });

  socket.on('error', ({ message }) => {
    toast(message, 'error');
    if (message.includes('not found') || message.includes('nicht gefunden')) {
      setTimeout(() => window.location.href = '/', 2000);
    }
  });

  socket.on('session_created', ({ sessionId: id, state }) => {
    sessionId = id;
    isHost = true;
    _applyFullState(state);
    _initAsHost();
    toast(`Session ${id} erstellt!`, 'success');
  });

  socket.on('session_joined', ({ sessionId: id, state }) => {
    sessionId = id;
    isHost = state.participants.find(p => p.socketId === socket.id)?.isHost || false;
    _applyFullState(state);
    if (!isHost) _initAsGuest(state);
    toast(`Session ${id} beigetreten!`, 'success');
  });

  socket.on('queue_updated', ({ queue: q, currentTrackIndex: idx }) => {
    queue = q;
    const trackChanged = idx !== currentTrackIndex;
    currentTrackIndex = idx;
    _renderQueue();

    if (isHost && trackChanged && idx >= 0) {
      // Host triggers playback of new current track
      DMHPlayer.play(queue[idx], 0);
      isPlaying = true;
      _updatePlayPauseBtn();
    }
  });

  socket.on('playback_updated', ({ currentTrackIndex: idx, isPlaying: playing, position, timestamp }) => {
    const prevIdx = currentTrackIndex;  // capture BEFORE overwriting
    currentTrackIndex = idx;
    isPlaying = playing;

    if (idx >= 0 && idx < queue.length) {
      _renderNowPlaying(queue[idx]);
      _renderQueue();
    }

    if (isHost) {
      _updatePlayPauseBtn();
      // Trigger actual audio playback — use prevIdx to detect track change
      if (prevIdx !== idx && idx >= 0 && queue[idx]) {
        DMHPlayer.play(queue[idx], position || 0);
      } else if (prevIdx === idx && idx >= 0) {
        if (playing) DMHPlayer.resume();
        else DMHPlayer.pause();
      }
    } else {
      // Guest: adjust position accounting for network delay
      const lag = Date.now() - (timestamp || Date.now());
      const adjustedPos = (position || 0) + (playing ? lag : 0);
      guestProgressMs = adjustedPos;
      guestProgressTimestamp = Date.now();
      _updateGuestProgress(queue[idx], adjustedPos);
    }
  });

  socket.on('playback_progress', ({ position, timestamp }) => {
    // Guests receive host's position updates
    if (isHost) return;
    const lag = Date.now() - (timestamp || Date.now());
    guestProgressMs = position + lag;
    guestProgressTimestamp = Date.now();
  });

  socket.on('settings_updated', ({ settings }) => {
    if (isHost) {
      toggleAllowJoin.checked = settings.allowJoin;
      toggleAllowAdd.checked  = settings.allowGuestAdd;
    }
    // If guest add was disabled, notify guests
    if (!isHost && !settings.allowGuestAdd) {
      btnAddSong.disabled = true;
      btnAddSong.title = 'Host hat das Hinzufügen gesperrt';
    } else if (!isHost) {
      btnAddSong.disabled = false;
      btnAddSong.title = '';
    }
  });

  socket.on('participant_joined', ({ username, participants }) => {
    toast(`${username} ist der Session beigetreten`, 'info');
    _renderParticipants(participants);
  });

  socket.on('participant_left', ({ username, participants }) => {
    toast(`${username} hat die Session verlassen`, 'info');
    _renderParticipants(participants);
  });

  socket.on('host_transferred', ({ newHostUsername, participants }) => {
    // Am I the new host?
    const me = participants.find(p => p.socketId === socket.id);
    if (me?.isHost) {
      isHost = true;
      _initAsHost();
      toast('Du bist jetzt der Host!', 'success');
    } else {
      toast(`${newHostUsername} ist jetzt der Host`, 'info');
    }
    _renderParticipants(participants);
  });

  // ── Apply full state (on join/create) ─────────────────────────────────────
  function _applyFullState(state) {
    sessionId = state.id;
    queue = state.queue || [];
    currentTrackIndex = state.currentTrackIndex ?? -1;
    isPlaying = state.isPlaying || false;

    // Update header
    if (headerSessionCode) headerSessionCode.textContent = state.id;
    document.title = `DMH — ${state.id}`;

    _renderQueue();
    _renderParticipants(state.participants || []);

    if (currentTrackIndex >= 0 && queue[currentTrackIndex]) {
      _renderNowPlaying(queue[currentTrackIndex]);
      // If guest joining an active session, sync progress
      if (!isHost && isPlaying && state.position > 0) {
        const lag = Date.now() - (state.lastPositionUpdate || Date.now());
        guestProgressMs = state.position + lag;
        guestProgressTimestamp = Date.now();
      }
    }

    // Apply settings
    if (state.settings) {
      if (isHost) {
        if (toggleAllowJoin) toggleAllowJoin.checked = state.settings.allowJoin;
        if (toggleAllowAdd)  toggleAllowAdd.checked  = state.settings.allowGuestAdd;
      }
    }
  }

  // ── Host Init ─────────────────────────────────────────────────────────────
  function _initAsHost() {
    isHost = true;
    if (hostBadge) hostBadge.style.display = 'inline-flex';
    if (playbackControls) playbackControls.style.display = 'flex';
    if (guestControls)    guestControls.style.display    = 'none';
    if (hostSettings)     hostSettings.style.display     = 'block';
    queueList && queueList.classList.add('host-view');

    // Show Spotify connect if no token
    if (!spotifyToken && spotifyConnectArea) {
      spotifyConnectArea.style.display = 'block';
    }

    // Init the player
    DMHPlayer.init({
      isHost: true,
      spotifyToken,
      onProgress: (posMs) => {
        socket.emit('playback_progress', { position: posMs });
        _updateProgressUI(queue[currentTrackIndex], posMs);
      },
      onEnded: () => {
        socket.emit('track_ended');
      },
      onReady: (source, deviceId) => {
        if (source === 'spotify') {
          if (spotifyStatusEl) spotifyStatusEl.style.display = 'flex';
          if (spotifyStatusText) spotifyStatusText.textContent = 'Spotify ✓';
          if (spotifyConnectArea) spotifyConnectArea.style.display = 'none';
          // Store device ID on server
          socket.emit('spotify_token_update', { token: spotifyToken });
        }
      }
    });

    // Progress bar seek (host)
    if (progressBarWrap) {
      progressBarWrap.style.cursor = 'pointer';
      progressBarWrap.addEventListener('click', (e) => {
        const track = queue[currentTrackIndex];
        if (!track || !track.duration) return;
        const rect = progressBarWrap.querySelector('.progress-bar-bg').getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const posMs = Math.floor(pct * track.duration);
        DMHPlayer.seek(posMs);
        socket.emit('playback_control', { action: 'seek', position: posMs });
        _updateProgressUI(track, posMs);
      });
    }

    // Settings toggles
    toggleAllowJoin && toggleAllowJoin.addEventListener('change', () => {
      socket.emit('settings_update', {
        allowJoin: toggleAllowJoin.checked,
        allowGuestAdd: toggleAllowAdd.checked
      });
    });
    toggleAllowAdd && toggleAllowAdd.addEventListener('change', () => {
      socket.emit('settings_update', {
        allowJoin: toggleAllowJoin.checked,
        allowGuestAdd: toggleAllowAdd.checked
      });
    });

    // Playback controls
    btnPlayPause && btnPlayPause.addEventListener('click', _handlePlayPause);
    btnPrev && btnPrev.addEventListener('click', () => {
      socket.emit('playback_control', { action: 'prev' });
    });
    btnNext && btnNext.addEventListener('click', () => {
      socket.emit('playback_control', { action: 'next' });
    });

    // Spotify token refresh
    if (spotifyToken) {
      _scheduleSpotifyRefresh();
    }

    _startGuestProgressTick(); // also for host UI
  }

  // ── Guest Init ────────────────────────────────────────────────────────────
  function _initAsGuest(state) {
    if (playbackControls) playbackControls.style.display = 'none';
    if (guestControls)    guestControls.style.display    = 'flex';
    if (hostSettings)     hostSettings.style.display     = 'none';
    if (spotifyConnectArea) spotifyConnectArea.style.display = 'none';
    if (hostBadge) hostBadge.style.display = 'none';

    DMHPlayer.init({ isHost: false, onProgress: () => {}, onEnded: () => {} });

    _startGuestProgressTick();
  }

  // ── Guest progress tick (visual-only interpolation) ───────────────────────
  function _startGuestProgressTick() {
    if (progressUpdateTimer) clearInterval(progressUpdateTimer);
    progressUpdateTimer = setInterval(() => {
      if (currentTrackIndex < 0 || !queue[currentTrackIndex]) return;
      const track = queue[currentTrackIndex];

      let posMs;
      if (isHost) {
        DMHPlayer.getCurrentPosition().then(p => {
          if (p !== null) _updateProgressUI(track, p);
        });
        return;
      }

      // Guest: interpolate
      if (isPlaying && guestProgressTimestamp > 0) {
        const elapsed = Date.now() - guestProgressTimestamp;
        posMs = guestProgressMs + elapsed;
        if (posMs > (track.duration || 0) && track.duration) posMs = track.duration;
        _updateProgressUI(track, posMs);
      } else {
        _updateProgressUI(track, guestProgressMs);
      }
    }, 500);
  }

  // ── Play/Pause button handler ─────────────────────────────────────────────
  async function _handlePlayPause() {
    if (!isHost) return;
    if (currentTrackIndex < 0 || !queue[currentTrackIndex]) return;

    if (isPlaying) {
      const pos = await DMHPlayer.getCurrentPosition();
      await DMHPlayer.pause();
      isPlaying = false;
      socket.emit('playback_control', { action: 'pause', position: pos });
    } else {
      await DMHPlayer.resume();
      isPlaying = true;
      socket.emit('playback_control', { action: 'play' });
    }
    _updatePlayPauseBtn();
  }

  // ── Spotify connect ───────────────────────────────────────────────────────
  btnSpotifyConnect && btnSpotifyConnect.addEventListener('click', () => {
    if (!sessionId) return;
    window.location.href = `/auth/spotify?sessionId=${sessionId}`;
  });

  // If we got a token back from OAuth redirect, init the player
  if (SPOTIFY_TOKEN) {
    toast('Spotify verbunden!', 'success');
    if (spotifyConnectArea) spotifyConnectArea.style.display = 'none';
    if (spotifyStatusEl) spotifyStatusEl.style.display = 'flex';
  }
  if (SPOTIFY_ERROR) {
    toast('Spotify-Verbindung fehlgeschlagen.', 'error');
  }

  // ── Spotify token refresh ─────────────────────────────────────────────────
  function _scheduleSpotifyRefresh() {
    if (spotifyRefreshTimer) clearTimeout(spotifyRefreshTimer);
    if (!spotifyRefresh) return;
    const now = Date.now();
    const msUntilExpiry = spotifyExpires - now - 60000; // refresh 1 min early
    const delay = msUntilExpiry > 0 ? msUntilExpiry : 0;
    spotifyRefreshTimer = setTimeout(_refreshSpotifyToken, delay);
  }

  async function _refreshSpotifyToken() {
    if (!spotifyRefresh) return;
    try {
      const res = await fetch('/auth/spotify/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: spotifyRefresh })
      });
      const data = await res.json();
      if (data.access_token) {
        spotifyToken = data.access_token;
        spotifyExpires = Date.now() + data.expires_in * 1000;
        sessionStorage.setItem('dmh_spotify_token', spotifyToken);
        sessionStorage.setItem('dmh_spotify_expires', String(spotifyExpires));
        DMHPlayer.setSpotifyToken(spotifyToken);
        DMHSearch.setSpotifyToken(spotifyToken);
        socket.emit('spotify_token_update', { token: spotifyToken });
        _scheduleSpotifyRefresh();
      }
    } catch (err) {
      console.error('[Session] Spotify refresh failed:', err);
    }
  }

  // ── Queue rendering ───────────────────────────────────────────────────────
  function _renderQueue() {
    if (!queueList) return;
    if (queueEmpty) queueEmpty.style.display = queue.length ? 'none' : 'flex';

    // Remove existing track items (but keep queueEmpty)
    const existing = queueList.querySelectorAll('.queue-item');
    existing.forEach(el => el.remove());

    queue.forEach((track, i) => {
      const div = document.createElement('div');
      div.className = 'queue-item' + (i === currentTrackIndex ? ' is-current' : '');
      div.dataset.index = i;
      div.draggable = isHost;

      div.innerHTML = `
        ${isHost ? `
        <div class="qi-drag" title="Ziehen zum Sortieren">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
            <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
          </svg>
        </div>` : ''}
        <span class="qi-index">${i === currentTrackIndex ? '▶' : i + 1}</span>
        <img class="qi-thumbnail" src="${_escAttr(track.thumbnail)}" alt=""
             onerror="this.style.visibility='hidden'" loading="lazy" />
        <div class="qi-info">
          <div class="qi-title">${_escHtml(track.title)}</div>
          <div class="qi-sub">${_escHtml(track.artist)}${track.addedBy ? ' · von ' + _escHtml(track.addedBy) : ''}</div>
        </div>
        <div class="qi-source-dot ${track.source}" title="${_sourceLabel(track.source)}"></div>
        <span class="qi-duration">${_fmtDuration(track.duration)}</span>
        ${isHost ? `
        <button class="qi-remove" data-index="${i}" title="Entfernen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
            <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>` : ''}
      `;

      // Remove button
      if (isHost) {
        const removeBtn = div.querySelector('.qi-remove');
        removeBtn && removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          socket.emit('queue_remove', { trackIndex: parseInt(e.currentTarget.dataset.index, 10) });
        });

        // Drag events
        div.addEventListener('dragstart', (e) => {
          dragFromIndex = i;
          div.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        div.addEventListener('dragend', () => {
          div.classList.remove('dragging');
          document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
          dragFromIndex = null;
        });
        div.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('drag-over'));
          div.classList.add('drag-over');
        });
        div.addEventListener('drop', (e) => {
          e.preventDefault();
          div.classList.remove('drag-over');
          if (dragFromIndex !== null && dragFromIndex !== i) {
            socket.emit('queue_reorder', { fromIndex: dragFromIndex, toIndex: i });
          }
        });
      }

      // Click to jump to this track (host only)
      if (isHost) {
        div.addEventListener('dblclick', () => {
          if (i !== currentTrackIndex) {
            currentTrackIndex = i;
            socket.emit('playback_control', { action: 'play', position: 0 });
            // Also trigger via queue logic hack: emit a synthetic queue update with correct idx
            // Actually just trust playback_updated from server
          }
        });
      }

      queueList.appendChild(div);
    });
  }

  // ── Now Playing rendering ─────────────────────────────────────────────────
  function _renderNowPlaying(track) {
    if (!track) return;
    if (npThumbnail)  npThumbnail.src  = track.thumbnail || '';
    if (npTitle)      npTitle.textContent  = track.title  || 'Unbekannt';
    if (npArtist)     npArtist.textContent = track.artist || '';
    if (npAlbum)      npAlbum.textContent  = (track.album && track.album !== 'YouTube Music') ? track.album : '';
    if (npAddedBy)    npAddedBy.textContent = track.addedBy ? `hinzugefügt von ${track.addedBy}` : '';

    if (npSourceBadge) {
      npSourceBadge.className = `np-source-badge source-${track.source}`;
      npSourceBadge.textContent = _sourceLabel(track.source);
      npSourceBadge.style.display = 'block';
    }

    if (progressTotal) progressTotal.textContent = _fmtDuration(track.duration);

    document.title = `DMH ▶ ${track.title} — ${track.artist}`;
  }

  function _updateProgressUI(track, posMs) {
    if (!track) return;
    const dur = track.duration || 1;
    const pct = Math.min(100, (posMs / dur) * 100);
    if (progressFill)   progressFill.style.width   = pct + '%';
    if (progressThumb)  progressThumb.style.left   = pct + '%';
    if (progressCurrent) progressCurrent.textContent = _fmtDuration(posMs);
    if (progressTotal)   progressTotal.textContent   = _fmtDuration(dur);
  }

  function _updateGuestProgress(track, posMs) {
    _updateProgressUI(track, posMs);
  }

  function _updatePlayPauseBtn() {
    if (!btnPlayPause) return;
    if (isPlaying) {
      if (iconPlay)  iconPlay.style.display  = 'none';
      if (iconPause) iconPause.style.display = 'block';
    } else {
      if (iconPlay)  iconPlay.style.display  = 'block';
      if (iconPause) iconPause.style.display = 'none';
    }
  }

  // ── Participants ──────────────────────────────────────────────────────────
  function _renderParticipants(participants) {
    if (participantCount) participantCount.textContent = participants.length;

    const buildList = (el) => {
      if (!el) return;
      el.innerHTML = '';
      participants.forEach(p => {
        const li = document.createElement('li');
        li.className = 'participant-item';
        const initial = (p.username || '?')[0].toUpperCase();
        li.innerHTML = `
          <div class="participant-avatar">${_escHtml(initial)}</div>
          <span class="participant-name">${_escHtml(p.username)}</span>
          ${p.isHost ? '<span class="participant-crown" title="Host">👑</span>' : ''}
        `;
        el.appendChild(li);
      });
    };

    buildList(participantList);
    buildList(participantsModalList);
  }

  // ── Add Song button ───────────────────────────────────────────────────────
  btnAddSong && btnAddSong.addEventListener('click', () => {
    DMHSearch.open();
  });

  // ── Local file upload ─────────────────────────────────────────────────────
  localFileInput && localFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Simple client-side audio metadata
    const audioMeta = await _getAudioMeta(file);

    if (uploadProgress)  uploadProgress.style.display = 'block';
    if (uploadProgressBar) uploadProgressBar.style.width = '0%';
    if (uploadProgressText) uploadProgressText.textContent = 'Wird hochgeladen…';

    const formData = new FormData();
    formData.append('audio', file);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/upload');

      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.round((ev.loaded / ev.total) * 100);
          if (uploadProgressBar) uploadProgressBar.style.width = pct + '%';
          if (uploadProgressText) uploadProgressText.textContent = `${pct}%`;
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          const data = JSON.parse(xhr.responseText);
          const track = {
            source: 'local',
            title: audioMeta.title || _stripExt(file.name),
            artist: audioMeta.artist || 'Unbekannt',
            album: audioMeta.album || 'Lokale Datei',
            duration: audioMeta.duration || 0,
            thumbnail: '',
            spotifyUri: null,
            youtubeId: null,
            localFileId: data.fileId
          };
          socket.emit('queue_add', { track });
          toast(`"${track.title}" hinzugefügt`, 'success');
        } else {
          toast('Upload fehlgeschlagen', 'error');
        }
        if (uploadProgress) uploadProgress.style.display = 'none';
        localFileInput.value = '';
      });

      xhr.addEventListener('error', () => {
        toast('Upload-Fehler', 'error');
        if (uploadProgress) uploadProgress.style.display = 'none';
        localFileInput.value = '';
      });

      xhr.send(formData);
    } catch (err) {
      toast('Upload fehlgeschlagen', 'error');
      if (uploadProgress) uploadProgress.style.display = 'none';
      localFileInput.value = '';
    }
  });

  async function _getAudioMeta(file) {
    return new Promise((resolve) => {
      const audio = new Audio();
      const url = URL.createObjectURL(file);
      audio.src = url;
      audio.addEventListener('loadedmetadata', () => {
        const duration = isFinite(audio.duration) ? Math.floor(audio.duration * 1000) : 0;
        URL.revokeObjectURL(url);
        resolve({ duration, title: null, artist: null, album: null });
      });
      audio.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        resolve({ duration: 0 });
      });
      // Timeout fallback
      setTimeout(() => { URL.revokeObjectURL(url); resolve({ duration: 0 }); }, 3000);
    });
  }

  // ── Copy session code ─────────────────────────────────────────────────────
  copyCodeBtn && copyCodeBtn.addEventListener('click', () => {
    if (!sessionId) return;
    navigator.clipboard.writeText(sessionId).then(() => {
      toast('Code kopiert!', 'success');
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = sessionId;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Code kopiert!', 'success');
    });
  });

  // ── Participants modal ────────────────────────────────────────────────────
  participantsBadge && participantsBadge.addEventListener('click', () => {
    if (participantsModal) participantsModal.style.display = 'flex';
  });
  participantsModalClose && participantsModalClose.addEventListener('click', () => {
    if (participantsModal) participantsModal.style.display = 'none';
  });
  participantsModalBackdrop && participantsModalBackdrop.addEventListener('click', () => {
    if (participantsModal) participantsModal.style.display = 'none';
  });

  // ── QR-Code modal ─────────────────────────────────────────────────────────
  const showQrBtn       = document.getElementById('showQrBtn');
  const qrModal         = document.getElementById('qrModal');
  const qrModalClose    = document.getElementById('qrModalClose');
  const qrModalBackdrop = document.getElementById('qrModalBackdrop');
  const qrCodeWrap      = document.getElementById('qrCodeWrap');
  const qrJoinUrl       = document.getElementById('qrJoinUrl');
  const qrCopyUrlBtn    = document.getElementById('qrCopyUrlBtn');
  const qrSessionCodeDisplay = document.getElementById('qrSessionCodeDisplay');

  let qrLoaded = false;

  function openQrModal() {
    if (!sessionId) return;
    if (qrModal) qrModal.style.display = 'flex';
    if (qrSessionCodeDisplay) qrSessionCodeDisplay.textContent = sessionId;
    if (!qrLoaded) _loadQr();
  }

  async function _loadQr() {
    if (!qrCodeWrap) return;
    qrCodeWrap.innerHTML = '<div class="qr-spinner"></div>';
    try {
      const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/qr`);
      const data = await res.json();
      if (!res.ok || !data.dataUrl) throw new Error(data.error || 'QR error');

      qrCodeWrap.innerHTML = `<img src="${data.dataUrl}" alt="QR Code" class="qr-image" />`;
      if (qrJoinUrl) qrJoinUrl.textContent = data.joinUrl;
      qrLoaded = true;
    } catch (err) {
      qrCodeWrap.innerHTML = '<p class="qr-error">QR konnte nicht geladen werden.</p>';
    }
  }

  showQrBtn && showQrBtn.addEventListener('click', openQrModal);
  qrModalClose    && qrModalClose.addEventListener('click',    () => { if (qrModal) qrModal.style.display = 'none'; });
  qrModalBackdrop && qrModalBackdrop.addEventListener('click', () => { if (qrModal) qrModal.style.display = 'none'; });

  qrCopyUrlBtn && qrCopyUrlBtn.addEventListener('click', () => {
    const url = qrJoinUrl?.textContent;
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => toast('Link kopiert!', 'success')).catch(() => {});
  });

  // Re-generate QR if session changes (shouldn't happen, but safe)
  socket.on('session_created', () => { qrLoaded = false; });

  // ── Init Search ───────────────────────────────────────────────────────────
  // Wait until we have sessionId
  const searchInitInterval = setInterval(() => {
    if (!sessionId) return;
    clearInterval(searchInitInterval);
    DMHSearch.init({
      sessionId,
      spotifyToken,
      onAddTrack: (track) => {
        socket.emit('queue_add', { track });
        toast(`"${track.title}" zur Queue hinzugefügt`, 'success');
      }
    });
  }, 100);

  // ── Toast helper ──────────────────────────────────────────────────────────
  window.DMHToast = {
    error: (msg) => toast(msg, 'error'),
    success: (msg) => toast(msg, 'success'),
    info: (msg) => toast(msg, 'info')
  };

  function toast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `toast toast-${type}`;
    div.textContent = message;
    container.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      div.style.transform = 'translateX(20px)';
      div.style.transition = 'all 0.3s ease';
      setTimeout(() => div.remove(), 300);
    }, 4000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _fmtDuration(ms) {
    if (!ms || ms <= 0) return '';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function _sourceLabel(source) {
    return { spotify: 'Spotify', youtube: 'YT Music', local: 'Lokal' }[source] || source;
  }

  function _stripExt(filename) {
    return filename.replace(/\.[^.]+$/, '');
  }

  function _escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _escAttr(str) {
    return String(str || '').replace(/"/g, '&quot;');
  }

})();
