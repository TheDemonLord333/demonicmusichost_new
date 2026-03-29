// ── DMH Search Modal ──────────────────────────────────────────────────────────
window.DMHSearch = (function () {
  'use strict';

  let _spotifyToken = null;
  let _sessionId = null;
  let _onAddTrack = null;
  let _currentSource = 'spotify';
  let _debounceTimer = null;

  const modal = document.getElementById('searchModal');
  const backdrop = document.getElementById('searchModalBackdrop');
  const closeBtn = document.getElementById('searchModalClose');
  const tabs = document.querySelectorAll('.search-tab');
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  const searchSpinner = document.getElementById('searchSpinner');
  const spotifyNoToken = document.getElementById('spotifyNoToken');
  const searchSpotifyConnectLink = document.getElementById('searchSpotifyConnectLink');

  function init({ sessionId, spotifyToken, onAddTrack }) {
    _sessionId = sessionId;
    _spotifyToken = spotifyToken || null;
    _onAddTrack = onAddTrack || (() => {});

    _bindEvents();
  }

  function setSpotifyToken(token) {
    _spotifyToken = token;
  }

  function open() {
    if (!modal) return;
    modal.style.display = 'flex';
    setTimeout(() => searchInput && searchInput.focus(), 100);
    _updateTabUI();
  }

  function close() {
    if (!modal) return;
    modal.style.display = 'none';
    if (searchInput) searchInput.value = '';
    if (searchResults) searchResults.innerHTML = '';
  }

  function _bindEvents() {
    closeBtn && closeBtn.addEventListener('click', close);
    backdrop && backdrop.addEventListener('click', close);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.style.display !== 'none') close();
    });

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        _currentSource = tab.dataset.source;
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        if (searchResults) searchResults.innerHTML = '';
        _updateTabUI();
        if (searchInput.value.trim().length >= 2) _doSearch(searchInput.value.trim());
      });
    });

    searchInput && searchInput.addEventListener('input', (e) => {
      clearTimeout(_debounceTimer);
      const q = e.target.value.trim();
      if (q.length < 2) {
        if (searchResults) searchResults.innerHTML = '';
        return;
      }
      _debounceTimer = setTimeout(() => _doSearch(q), 400);
    });

    searchSpotifyConnectLink && searchSpotifyConnectLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = `/auth/spotify?sessionId=${_sessionId}`;
    });
  }

  function _updateTabUI() {
    if (!spotifyNoToken) return;
    if (_currentSource === 'spotify' && !_spotifyToken) {
      spotifyNoToken.style.display = 'flex';
    } else {
      spotifyNoToken.style.display = 'none';
    }
  }

  async function _doSearch(q) {
    if (!searchResults) return;
    if (_currentSource === 'spotify' && !_spotifyToken) {
      searchResults.innerHTML = '<div class="search-warning" style="margin:1rem">Spotify nicht verbunden.</div>';
      return;
    }

    searchSpinner && (searchSpinner.style.display = 'block');
    searchResults.innerHTML = '';

    try {
      let url;
      if (_currentSource === 'spotify') {
        url = `/search/spotify?q=${encodeURIComponent(q)}&token=${encodeURIComponent(_spotifyToken)}`;
      } else {
        url = `/search/youtube?q=${encodeURIComponent(q)}`;
      }

      const res = await fetch(url);

      if (res.status === 401 && _currentSource === 'spotify') {
        _spotifyToken = null;
        _updateTabUI();
        searchResults.innerHTML = '<div class="search-error">Spotify-Token abgelaufen. Bitte erneut verbinden.</div>';
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        searchResults.innerHTML = `<div class="search-error">${data.error || 'Suche fehlgeschlagen'}</div>`;
        return;
      }

      const { tracks } = await res.json();

      if (!tracks || tracks.length === 0) {
        searchResults.innerHTML = '<div class="search-empty">Keine Ergebnisse gefunden.</div>';
        return;
      }

      searchResults.innerHTML = '';
      tracks.forEach(track => {
        const item = _buildResultItem(track);
        searchResults.appendChild(item);
      });
    } catch (err) {
      console.error('[Search] Error:', err);
      searchResults.innerHTML = '<div class="search-error">Netzwerkfehler bei der Suche.</div>';
    } finally {
      searchSpinner && (searchSpinner.style.display = 'none');
    }
  }

  function _buildResultItem(track) {
    const div = document.createElement('div');
    div.className = 'search-result-item';

    const duration = _fmtDuration(track.duration);
    const thumbnail = track.thumbnail || '';

    div.innerHTML = `
      <img class="sr-thumbnail" src="${_escapeAttr(thumbnail)}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'" />
      <div class="sr-info">
        <div class="sr-title">${_escapeHtml(track.title)}</div>
        <div class="sr-sub">${_escapeHtml(track.artist)}${track.album && track.album !== 'YouTube Music' ? ' · ' + _escapeHtml(track.album) : ''}</div>
      </div>
      <span class="sr-duration">${duration}</span>
      <button class="sr-add-btn" title="Hinzufügen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="14" height="14">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>
    `;

    const addBtn = div.querySelector('.sr-add-btn');
    const doAdd = () => {
      _onAddTrack(track);
      // Brief feedback
      addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#1DB954" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      addBtn.style.background = 'rgba(29,185,84,0.2)';
      addBtn.disabled = true;
      setTimeout(() => {
        addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
        addBtn.style.background = '';
        addBtn.disabled = false;
      }, 2000);
    };

    addBtn.addEventListener('click', (e) => { e.stopPropagation(); doAdd(); });
    div.addEventListener('click', doAdd);

    return div;
  }

  function _fmtDuration(ms) {
    if (!ms || ms <= 0) return '';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function _escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _escapeAttr(str) {
    return String(str || '').replace(/"/g, '&quot;');
  }

  return { init, open, close, setSpotifyToken };
})();
