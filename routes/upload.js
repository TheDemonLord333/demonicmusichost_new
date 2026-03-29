const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const ALLOWED_AUDIO_EXTS = new Set([
  '.mp3', '.mp4', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.opus', '.weba', '.webm'
]);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk = file.mimetype.startsWith('audio/') ||
                   file.mimetype.startsWith('video/mp4') || // some browsers label m4a/mp4 as video/mp4
                   file.mimetype === 'application/octet-stream'; // generic fallback
    if (ALLOWED_AUDIO_EXTS.has(ext) || mimeOk) {
      cb(null, true);
    } else {
      cb(new Error(`Dateityp nicht erlaubt: ${ext || file.mimetype}`));
    }
  }
});

const MIME_MAP = {
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm'
};

module.exports = function (sessions) {
  const router = express.Router();

  // POST /upload — upload a local audio file
  // Call multer inline so we can return proper JSON errors instead of HTML 500.
  router.post('/', (req, res) => {
    upload.single('audio')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Datei zu groß (max. 150 MB)' });
        }
        return res.status(400).json({ error: err.message || 'Upload fehlgeschlagen' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'Keine Datei übermittelt' });
      }
      res.json({
        fileId: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      });
    });
  });

  // GET /upload/stream/:fileId — stream audio with HTTP range support
  router.get('/stream/:fileId', (req, res) => {
    const fileId = path.basename(req.params.fileId); // path-traversal guard
    const filePath = path.join(uploadsDir, fileId);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Datei nicht gefunden' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const ext = path.extname(fileId).toLowerCase();
    const contentType = MIME_MAP[ext] || 'audio/mpeg';
    const range = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize) {
        return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      }

      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  return router;
};
