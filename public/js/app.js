// ── Home Page ─────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  // ── Spotify token storage helpers ─────────────────────────────────────────
  const SS = {
    saveSpotify: (token, refresh, expires) => {
      sessionStorage.setItem('dmh_spotify_token', token);
      sessionStorage.setItem('dmh_spotify_refresh', refresh || '');
      sessionStorage.setItem('dmh_spotify_expires', String(expires || 0));
    },
    loadSpotify: () => ({
      token:   sessionStorage.getItem('dmh_spotify_token'),
      refresh: sessionStorage.getItem('dmh_spotify_refresh'),
      expires: parseInt(sessionStorage.getItem('dmh_spotify_expires') || '0', 10)
    }),
    clearSpotify: () => {
      sessionStorage.removeItem('dmh_spotify_token');
      sessionStorage.removeItem('dmh_spotify_refresh');
      sessionStorage.removeItem('dmh_spotify_expires');
    },
    isValid: () => {
      const { token, expires } = SS.loadSpotify();
      return !!token && (expires === 0 || expires > Date.now() + 60000);
    },
    saveUsername: (name) => sessionStorage.setItem('dmh_username', name),
    loadUsername: () => sessionStorage.getItem('dmh_username') || ''
  };

  // ── Handle OAuth redirect back to home ────────────────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const incomingToken   = urlParams.get('spotify_token');
  const incomingRefresh = urlParams.get('spotify_refresh');
  const incomingExpires = parseInt(urlParams.get('spotify_expires') || '0', 10);
  const spotifyError    = urlParams.get('spotify_error');

  if (incomingToken) {
    SS.saveSpotify(incomingToken, incomingRefresh, incomingExpires);
    // Clean URL
    window.history.replaceState({}, '', '/');
  }
  if (spotifyError) {
    window.history.replaceState({}, '', '/');
  }

  // ── Spotify connect UI ────────────────────────────────────────────────────
  const spotifyDisconnected = document.getElementById('spotifyDisconnected');
  const spotifyConnected    = document.getElementById('spotifyConnected');
  const btnPreConnect       = document.getElementById('btnSpotifyPreConnect');
  const btnDisconnect       = document.getElementById('btnSpotifyDisconnect');

  function updateSpotifyUI() {
    if (!spotifyDisconnected || !spotifyConnected) return;
    if (SS.isValid()) {
      spotifyDisconnected.style.display = 'none';
      spotifyConnected.style.display = 'flex';
    } else {
      spotifyDisconnected.style.display = 'flex';
      spotifyConnected.style.display = 'none';
    }
  }
  updateSpotifyUI();

  if (spotifyError) showError('Spotify-Verbindung fehlgeschlagen. Bitte erneut versuchen.');
  if (incomingToken) showSuccess('Spotify erfolgreich verbunden!');

  btnPreConnect && btnPreConnect.addEventListener('click', () => {
    window.location.href = '/auth/spotify?from=home';
  });

  btnDisconnect && btnDisconnect.addEventListener('click', () => {
    SS.clearSpotify();
    updateSpotifyUI();
  });

  // ── Animated background particles ─────────────────────────────────────────
  const container = document.getElementById('bgParticles');
  if (container) {
    for (let i = 0; i < 40; i++) {
      const dot = document.createElement('div');
      const size = Math.random() * 3 + 1;
      dot.style.cssText = `
        position:absolute;
        width:${size}px;height:${size}px;border-radius:50%;
        background:rgba(${Math.random() > 0.5 ? '192,0,10' : '90,0,128'},${Math.random() * 0.4 + 0.05});
        left:${Math.random() * 100}%;top:${Math.random() * 100}%;
        animation:float${i % 3} ${6 + Math.random() * 10}s ease-in-out infinite;
        animation-delay:-${Math.random() * 10}s;
      `;
      container.appendChild(dot);
    }
    const style = document.createElement('style');
    style.textContent = `
      @keyframes float0{0%,100%{transform:translateY(0)}50%{transform:translateY(-20px)}}
      @keyframes float1{0%,100%{transform:translateY(0) translateX(0)}50%{transform:translateY(-15px) translateX(10px)}}
      @keyframes float2{0%,100%{transform:translateY(0) translateX(0)}50%{transform:translateY(-25px) translateX(-10px)}}
    `;
    document.head.appendChild(style);
  }

  // ── Notifications ─────────────────────────────────────────────────────────
  function showError(message) {
    const el = document.getElementById('homeError');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast toast-error';
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }
  function showSuccess(message) {
    const el = document.getElementById('homeError');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast toast-success';
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  function sanitizeCode(val) {
    return val.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  }

  // Build URL params including Spotify tokens if available
  function buildSessionParams(base) {
    const { token, refresh, expires } = SS.loadSpotify();
    if (token && SS.isValid()) {
      base.set('spotify_token', token);
      base.set('spotify_refresh', refresh || '');
      base.set('spotify_expires', String(expires));
    }
    return base;
  }

  // ── Create Session ────────────────────────────────────────────────────────
  const createForm = document.getElementById('createForm');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('createUsername').value.trim();
      if (!username) return showError('Bitte gib deinen Namen ein.');

      SS.saveUsername(username);

      const btn = createForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Erstelle…';

      const p = buildSessionParams(new URLSearchParams({ create: '1', username }));
      window.location.href = `/session.html?${p}`;
    });
  }

  // ── Join Session ──────────────────────────────────────────────────────────
  const joinForm = document.getElementById('joinForm');
  if (joinForm) {
    joinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('joinUsername').value.trim();
      const code = sanitizeCode(document.getElementById('sessionCode').value);

      if (!username) return showError('Bitte gib deinen Namen ein.');
      if (!code) return showError('Bitte gib einen Session-Code ein.');

      const codeId = code.startsWith('DMH-') ? code : `DMH-${code}`;

      const btn = joinForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Beitrete…';

      try {
        const res = await fetch(`/api/session/${encodeURIComponent(codeId)}`);
        const data = await res.json();
        if (!res.ok) {
          showError(data.error || 'Session nicht gefunden.');
          btn.disabled = false;
          btn.querySelector('span').textContent = 'Beitreten';
          return;
        }
        if (!data.allowJoin) {
          showError('Diese Session ist gesperrt. Kein Beitritt möglich.');
          btn.disabled = false;
          btn.querySelector('span').textContent = 'Beitreten';
          return;
        }

        SS.saveUsername(username);
        const p = buildSessionParams(new URLSearchParams({ join: codeId, username }));
        window.location.href = `/session.html?${p}`;
      } catch (err) {
        showError('Netzwerkfehler. Ist der Server erreichbar?');
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Beitreten';
      }
    });
  }

  // Auto-fill session code from URL hash
  const hash = window.location.hash.replace('#', '');
  if (hash && document.getElementById('sessionCode')) {
    document.getElementById('sessionCode').value = hash;
  }

  // Pre-fill username from last session
  const savedName = SS.loadUsername();
  if (savedName) {
    const cu = document.getElementById('createUsername');
    const ju = document.getElementById('joinUsername');
    if (cu && !cu.value) cu.value = savedName;
    if (ju && !ju.value) ju.value = savedName;
  }
})();
