const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const multer = require('multer');
const auth = require('basic-auth');

const app = express();
const PORT = 3000;

const SSD_PATH = process.platform === 'win32' ? 'E:\\' : '/media/username/SSD_NAME';
const THUMBNAIL_CACHE_DIR = path.join(__dirname, '.thumbnail-cache');

// Create thumbnail cache directory if it doesn't exist
(async () => {
  try {
    await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  } catch (err) {
    console.error('Error creating thumbnail cache directory:', err);
  }
})();

// 🔒 Basic Auth Middleware
const authenticate = (req, res, next) => {
  const user = auth(req);
  const username = 'fahad'; // 🔑 set your desired username
  const password = 'admin@fahad'; // 🔑 set your desired password

  if (!user || user.name !== username || user.pass !== password) {
    res.set('WWW-Authenticate', 'Basic realm="Protected Area"');
    return res.status(401).send('Authentication required.');
  }
  next();
};

app.use(authenticate); // Apply globally to all routes

// API routes
app.get('/api/list', async (req, res) => {
  const dir = req.query.dir || '';
  const fullPath = path.join(SSD_PATH, dir);

  try {
    const files = await fs.readdir(fullPath, { withFileTypes: true });
    const result = files.map(f => ({
      name: f.name,
      isDirectory: f.isDirectory()
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Could not list directory', details: err.message });
  }
});

app.get('/api/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path query is required' });

  const fullPath = path.join(SSD_PATH, filePath);
  const stream = fs.createReadStream(fullPath);

  stream.on('error', (err) => {
    console.error('Error streaming file:', err);
    if (!res.headersSent) {
        res.status(404).send('File not found');
    }
  });

  res.attachment(path.basename(fullPath));
  stream.pipe(res);
});

app.get('/api/thumbnail', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path query is required' });

  const fullPath = path.join(SSD_PATH, filePath);
  const ext = path.extname(fullPath).toLowerCase();
  const cacheKey = filePath.replace(/[^a-zA-Z0-9]/g, '_') + '.png';
  const cachePath = path.join(THUMBNAIL_CACHE_DIR, cacheKey);

  try {
    // Check if thumbnail exists in cache
    await fs.access(cachePath);
    res.sendFile(cachePath);
  } catch (err) {
    // If not in cache, generate it
    if (!['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
      return res.status(400).json({ error: 'Not an image file' });
    }

    try {
        await fs.access(fullPath);
    } catch (fileErr) {
        return res.status(404).json({ error: 'File not found' });
    }

    sharp(fullPath)
      .resize(100, 100, { fit: 'cover' })
      .toFile(cachePath, (sharpErr, info) => {
        if (sharpErr) {
          console.error(sharpErr);
          return res.status(500).json({ error: 'Thumbnail generation failed' });
        }
        res.sendFile(cachePath);
      });
  }
});

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const dir = req.query.dir || '';
  const fullPath = path.join(SSD_PATH, dir, req.file.originalname);

  try {
    await fs.writeFile(fullPath, req.file.buffer);
    res.json({ success: true, file: req.file.originalname });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Serve frontend
app.use(express.static('public'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
