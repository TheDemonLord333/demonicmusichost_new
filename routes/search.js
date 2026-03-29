const express = require('express');
const axios = require('axios');
const router = express.Router();

// ─── Spotify Search ────────────────────────────────────────────────────────────
router.get('/spotify', async (req, res) => {
  const { q, token } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  if (!token) return res.status(401).json({ error: 'Spotify token required' });

  try {
    const response = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q, type: 'track', limit: 20, market: 'DE' }
    });

    const tracks = response.data.tracks.items
      .filter(t => t && t.id)
      .map(t => ({
        source: 'spotify',
        title: t.name,
        artist: t.artists.map(a => a.name).join(', '),
        album: t.album.name,
        duration: t.duration_ms,
        thumbnail: t.album.images[0]?.url || '',
        spotifyUri: t.uri,
        youtubeId: null,
        localFileId: null,
        previewUrl: t.preview_url || null
      }));

    res.json({ tracks });
  } catch (err) {
    const status = err.response?.status || 500;
    if (status === 401) {
      return res.status(401).json({ error: 'Spotify token expired' });
    }
    console.error('[Search] Spotify error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Spotify search failed' });
  }
});

// ─── YouTube Music Search ──────────────────────────────────────────────────────
// Uses YouTube Data API v3 filtered to music category
router.get('/youtube', async (req, res) => {
  const { q } = req.query;
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!q) return res.status(400).json({ error: 'Missing query' });
  if (!apiKey) return res.status(500).json({ error: 'YouTube API key not configured' });

  try {
    // Search with music category filter
    const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: apiKey,
        q: q + ' audio',   // bias toward audio results
        part: 'snippet',
        type: 'video',
        videoCategoryId: '10',   // Music
        topicId: '/m/04rlf',     // Music topic filter
        maxResults: 20,
        safeSearch: 'none'
      }
    });

    if (!searchRes.data.items?.length) {
      return res.json({ tracks: [] });
    }

    const videoIds = searchRes.data.items.map(i => i.id.videoId).filter(Boolean);

    // Fetch durations in a second request
    const detailsRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        key: apiKey,
        id: videoIds.join(','),
        part: 'contentDetails,snippet'
      }
    });

    const durationMap = {};
    for (const item of detailsRes.data.items) {
      durationMap[item.id] = parseISO8601Duration(item.contentDetails.duration);
    }

    const tracks = searchRes.data.items
      .filter(i => i.id?.videoId)
      .map(i => ({
        source: 'youtube',
        title: decodeHtmlEntities(i.snippet.title),
        artist: i.snippet.channelTitle,
        album: 'YouTube Music',
        duration: durationMap[i.id.videoId] || 0,
        thumbnail: i.snippet.thumbnails.high?.url || i.snippet.thumbnails.default?.url || '',
        spotifyUri: null,
        youtubeId: i.id.videoId,
        localFileId: null
      }));

    res.json({ tracks });
  } catch (err) {
    console.error('[Search] YouTube error:', err.response?.data || err.message);
    res.status(500).json({ error: 'YouTube Music search failed' });
  }
});

function parseISO8601Duration(str) {
  if (!str) return 0;
  const m = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return ((parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0)) * 1000;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

module.exports = router;
