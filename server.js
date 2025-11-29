const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const multer = require('multer');
const auth = require('basic-auth');
const mime = require('mime-types');

const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const UPLOAD_QUEUE = 'uploads.queue';

// where uploads land first
const TEMP_UPLOAD_DIR = path.join(__dirname, '.upload-tmp');
// where job status JSON lives (API & worker both read/write here)
const JOB_STATE_DIR = path.join(__dirname, '.job-state');

(async () => {
  await fs.promises.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
  await fs.promises.mkdir(JOB_STATE_DIR, { recursive: true });
})();

function safeJoin(base, target) {
  const targetPath = path.resolve(base, target);
  if (!targetPath.startsWith(path.resolve(base) + path.sep)) {
    throw new Error('Unsafe path');
  }
  return targetPath;
}

async function moveFile(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(src, dest); // fast when same volume
  } catch (err) {
    if (err.code === 'EXDEV' || err.code === 'EPERM') {
      // cross-device or Windows rename edge-case: copy + unlink
      await fs.promises.copyFile(src, dest);
      await fs.promises.unlink(src);
    } else {
      throw err;
    }
  }
}


const app = express();
const PORT = 3000;


let amqpConn;
let amqpChannel;

async function initRabbit() {
  amqpConn = await amqp.connect(RABBITMQ_URL);
  amqpChannel = await amqpConn.createChannel();
    await amqpChannel.assertQueue("job_updates", { durable: true });
  await amqpChannel.assertQueue(UPLOAD_QUEUE, {
    durable: true
  });
  // ensure messages are persisted
  amqpChannel.prefetch(1); // worker will do prefetch, too (safe to keep here)


    amqpChannel.consume("job_updates", async (msg) => {
    const update = JSON.parse(msg.content.toString());
    const filePath = path.join(JOB_STATE_DIR, `${update.id}.json`);
    update.updatedAt = Date.now();
    await fs.promises.writeFile(filePath, JSON.stringify(update));
    amqpChannel.ack(msg);
  });


  console.log('RabbitMQ connected, queue ready:', UPLOAD_QUEUE);
}

initRabbit().catch(err => {
  console.error('RabbitMQ init error:', err);
  process.exit(1); // fail fast if queue is required
});


const SSD_PATH = process.platform === 'win32' ? 'E:\\' : '/media/username/SSD_NAME';
const THUMBNAIL_CACHE_DIR = path.join(__dirname, '.thumbnail-cache');

// Create thumbnail cache directory if it doesn't exist
(async () => {
  try {
    await fs.promises.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
    // Clear out old cache files on startup
    const files = await fs.promises.readdir(THUMBNAIL_CACHE_DIR);
    for (const file of files) {
      await fs.promises.unlink(path.join(THUMBNAIL_CACHE_DIR, file));
    }
    console.log('Thumbnail cache cleared.');
  } catch (err) {
    console.error('Error initializing thumbnail cache directory:', err);
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
    const files = await fs.promises.readdir(fullPath, { withFileTypes: true });
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

app.get('/api/media', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path query is required' });

  const fullPath = path.join(SSD_PATH, filePath);
  const mimeType = mime.lookup(fullPath);
  if (mimeType) {
    res.setHeader('Content-Type', mimeType);
  }

  const stream = fs.createReadStream(fullPath);

  stream.on('error', (err) => {
    console.error('Error streaming file:', err);
    if (!res.headersSent) {
        res.status(404).send('File not found');
    }
  });

  stream.pipe(res);
});

app.get('/api/thumbnail', async (req, res) => {
  console.log('---');
  console.log('Thumbnail request received for:', req.query.path);
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path query is required' });

  const fullPath = path.join(SSD_PATH, filePath);
  const ext = path.extname(fullPath).toLowerCase();
  const cacheKey = filePath.replace(/[^a-zA-Z0-9]/g, '_') + '.png';
  const cachePath = path.join(THUMBNAIL_CACHE_DIR, cacheKey);

  console.log('Original file path:', fullPath);
  console.log('Cache path:', cachePath);

  try {
    // Check if thumbnail exists in cache
    await fs.promises.access(cachePath);
    console.log('Cache hit. Sending cached thumbnail.');
    return res.sendFile(cacheKey, { root: THUMBNAIL_CACHE_DIR });
  } catch (err) {
    console.log('Cache miss. Generating new thumbnail.');
    // If not in cache, generate it
    if (!['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
      console.log('File is not a supported image type.');
      return res.status(400).json({ error: 'Not an image file' });
    }

    try {
      await fs.promises.access(fullPath);
    } catch (fileErr) {
      console.log('Original file not found at:', fullPath);
      return res.status(404).json({ error: 'File not found' });
    }

    try {
      await sharp(fullPath)
        .resize(100, 100, { fit: 'cover' })
        .toFile(cachePath);
      
      console.log('Thumbnail generated successfully. Sending file.');
      return res.sendFile(cacheKey, { root: THUMBNAIL_CACHE_DIR });
    } catch (sharpErr) {
      console.error('Sharp error during thumbnail generation:', sharpErr);
      return res.status(500).json({ error: 'Thumbnail generation failed' });
    }
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_UPLOAD_DIR),
  filename: (req, file, cb) => {
    // keep original name but prefix a unique ID to avoid collisions
    const unique = uuidv4();
    cb(null, `${unique}__${file.originalname}`);
  }
});
const upload = multer({ storage });




app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const tempPath = req.file.path;
    const targetDir = req.body.targetDir || "";
    const targetPath = path.join(SSD_PATH, targetDir, req.file.originalname);

    const jobId = uuidv4();

    amqpChannel.sendToQueue(
      "file_uploads",
      Buffer.from(JSON.stringify({ jobId, tempPath, targetPath }))
    );

    res.json({
      accepted: true,
      jobId,
      file: req.file.originalname   // 👈 match frontend
    });

  } catch (err) {
    console.error("❌ Failed to queue upload:", err);
    res.status(500).json({
      accepted: false,
      error: err.message || "Failed to queue upload"
    });
  }
});




// Get a single job
app.get('/api/job/:id', async (req, res) => {
  const p = path.join(JOB_STATE_DIR, `${req.params.id}.json`);
  try {
    const json = await fs.promises.readFile(p, 'utf8');
    res.type('application/json').send(json);
  } catch (e) {
    res.status(404).json({ error: 'Job not found' });
  }
});

// Batch query: /api/jobs?ids=job1,job2,job3
app.get('/api/jobs', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return res.json([]);
  const results = [];
  for (const id of ids) {
    const p = path.join(JOB_STATE_DIR, `${id}.json`);
    try {
      const json = await fs.promises.readFile(p, 'utf8');
      results.push(JSON.parse(json));
    } catch {
      results.push({ id, status: 'unknown' });
    }
  }
  res.json(results);
});

// (Optional) List recent jobs
app.get('/api/jobs/recent', async (req, res) => {
  const files = await fs.promises.readdir(JOB_STATE_DIR);
  const jobs = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const json = await fs.promises.readFile(path.join(JOB_STATE_DIR, f), 'utf8');
    jobs.push(JSON.parse(json));
  }
  // sort latest first
  jobs.sort((a,b) => b.updatedAt - a.updatedAt);
  res.json(jobs.slice(0, 100));
});


// Serve frontend
app.use(express.static('public'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});


// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('SIGINT received. Cleaning up and shutting down...');
  try {
    await fs.promises.rm(THUMBNAIL_CACHE_DIR, { recursive: true, force: true });
    console.log('Thumbnail cache directory removed.');
  } catch (err) {
    console.error('Error removing thumbnail cache directory:', err);
  }
  process.exit(0);
});