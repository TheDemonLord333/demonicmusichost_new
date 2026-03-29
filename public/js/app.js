// ── Home Page ─────────────────────────────────────────────────────────────────
// Handles session creation and joining without socket.io
// Redirects to session.html after interacting with the server API

(function () {
  'use strict';

  // Animated background particles (purely cosmetic)
  const container = document.getElementById('bgParticles');
  if (container) {
    for (let i = 0; i < 40; i++) {
      const dot = document.createElement('div');
      const size = Math.random() * 3 + 1;
      dot.style.cssText = `
        position:absolute;
        width:${size}px;
        height:${size}px;
        border-radius:50%;
        background:rgba(${Math.random() > 0.5 ? '192,0,10' : '90,0,128'},${Math.random() * 0.4 + 0.05});
        left:${Math.random() * 100}%;
        top:${Math.random() * 100}%;
        animation: float${i % 3} ${6 + Math.random() * 10}s ease-in-out infinite;
        animation-delay: -${Math.random() * 10}s;
      `;
      container.appendChild(dot);
    }

    const style = document.createElement('style');
    style.textContent = `
      @keyframes float0 { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-20px)} }
      @keyframes float1 { 0%,100%{transform:translateY(0) translateX(0)} 50%{transform:translateY(-15px) translateX(10px)} }
      @keyframes float2 { 0%,100%{transform:translateY(0) translateX(0)} 50%{transform:translateY(-25px) translateX(-10px)} }
    `;
    document.head.appendChild(style);
  }

  function showError(message) {
    const el = document.getElementById('homeError');
    if (!el) return;
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  function sanitizeCode(val) {
    return val.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  }

  // ── Create Session ────────────────────────────────────────────────────────────
  const createForm = document.getElementById('createForm');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('createUsername').value.trim();
      if (!username) return showError('Bitte gib deinen Namen ein.');

      const btn = createForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Erstelle…';

      try {
        // We create the session via socket.io on the session page itself.
        // Just pass params via URL.
        const params = new URLSearchParams({ create: '1', username });
        window.location.href = `/session.html?${params}`;
      } catch (err) {
        showError('Fehler beim Erstellen der Session.');
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Session starten';
      }
    });
  }

  // ── Join Session ──────────────────────────────────────────────────────────────
  const joinForm = document.getElementById('joinForm');
  if (joinForm) {
    joinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('joinUsername').value.trim();
      const code = sanitizeCode(document.getElementById('sessionCode').value);

      if (!username) return showError('Bitte gib deinen Namen ein.');
      if (!code) return showError('Bitte gib einen Session-Code ein.');

      // Validate code format: DMH-XXXXXX
      const codeId = code.startsWith('DMH-') ? code : `DMH-${code}`;

      const btn = joinForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Beitrete…';

      try {
        // Check if session exists
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
        const params = new URLSearchParams({ join: codeId, username });
        window.location.href = `/session.html?${params}`;
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
})();
