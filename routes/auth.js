const express = require('express');
const axios = require('axios');
const querystring = require('querystring');

module.exports = function (sessions) {
  const router = express.Router();

  const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
  const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3000/auth/spotify/callback';

  // Redirect user to Spotify OAuth
  // Query params: sessionId (in-session connect) OR from=home (pre-session connect)
  router.get('/spotify', (req, res) => {
    const { sessionId, from } = req.query;
    if (!CLIENT_ID) {
      return res.status(500).send('Spotify Client ID not configured.');
    }
    const scope = [
      'streaming',
      'user-read-email',
      'user-read-private',
      'user-modify-playback-state',
      'user-read-playback-state'
    ].join(' ');

    // state encodes where to redirect after auth:
    // 'home'       → back to home page with token
    // 'DMH-XXXXX'  → back to session page with token
    const state = sessionId || (from === 'home' ? 'home' : 'home');

    const url = 'https://accounts.spotify.com/authorize?' + querystring.stringify({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope,
      state
    });
    res.redirect(url);
  });

  // Spotify OAuth callback
  router.get('/spotify/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const isHomeFlow = !state || state === 'home';

    if (error || !code) {
      if (isHomeFlow) return res.redirect('/?spotify_error=access_denied');
      return res.redirect(`/session.html?sessionId=${state}&spotify_error=access_denied`);
    }

    try {
      const tokenRes = await axios.post(
        'https://accounts.spotify.com/api/token',
        querystring.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI
        }),
        {
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const { access_token, refresh_token, expires_in } = tokenRes.data;
      const tokenParams = new URLSearchParams({
        spotify_token: access_token,
        spotify_refresh: refresh_token,
        spotify_expires: String(Date.now() + expires_in * 1000)
      });

      if (isHomeFlow) {
        // Redirect back to home page with token — app.js stores it in sessionStorage
        res.redirect(`/?${tokenParams.toString()}`);
      } else {
        // Redirect back to session page so the host can reconnect
        tokenParams.set('sessionId', state);
        res.redirect(`/session.html?${tokenParams.toString()}`);
      }
    } catch (err) {
      console.error('[Auth] Spotify token error:', err.response?.data || err.message);
      if (isHomeFlow) return res.redirect('/?spotify_error=token_failed');
      res.redirect(`/session.html?sessionId=${state}&spotify_error=token_failed`);
    }
  });

  // Refresh Spotify access token
  router.post('/spotify/refresh', async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });

    try {
      const tokenRes = await axios.post(
        'https://accounts.spotify.com/api/token',
        querystring.stringify({ grant_type: 'refresh_token', refresh_token }),
        {
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      res.json({
        access_token: tokenRes.data.access_token,
        expires_in: tokenRes.data.expires_in
      });
    } catch (err) {
      console.error('[Auth] Refresh error:', err.response?.data || err.message);
      res.status(400).json({ error: 'Failed to refresh token' });
    }
  });

  return router;
};
