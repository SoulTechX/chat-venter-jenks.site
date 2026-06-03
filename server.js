const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const bcrypt = require('bcrypt');
const multer = require('multer');
const webpush = require('web-push');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');

// ── Logger con timestamps ─────────────────────────────────────────────────────
const log = (level, msg) => console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);

const app = express();
const server = http.createServer(app);

// #1 FIX: CORS restringido al dominio real (no "*")
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://chat.venter-jenks.site';
const io = new Server(server, {
  cors: {
    origin: [ALLOWED_ORIGIN, 'http://localhost:3000'],
    methods: ['GET', 'POST']
  }
});

// ── Constants & Config ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'tickets.db');

// ── VAPID Keys ────────────────────────────────────────────────────────────────
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  const generated = webpush.generateVAPIDKeys();
  vapidKeys.publicKey = generated.publicKey;
  vapidKeys.privateKey = generated.privateKey;
  log('WARN', '--- NUEVAS CLAVES VAPID GENERADAS (agréguelas al .env) ---');
  log('WARN', `VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
  log('WARN', `VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
}

webpush.setVapidDetails(
  'mailto:soporte@venter-jenks.site',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// ── Env & Paths ───────────────────────────────────────────────────────────────
const CHAT_HISTORY_DIR = process.env.CHAT_HISTORY_DIR || path.join(__dirname, 'data', 'chat');
const UPLOAD_DIR       = process.env.UPLOAD_DIR       || path.join(__dirname, 'uploads', 'chat');
const CHAT_RETENTION_DAYS = parseInt(process.env.CHAT_RETENTION_DAYS) || 5;
const MAX_UPLOAD_SIZE_MB  = parseFloat(process.env.MAX_UPLOAD_SIZE_MB) || 25;
const MAX_DAILY_UPLOAD_GB = parseFloat(process.env.MAX_DAILY_UPLOAD_GB) || 2;
const HARD_LIMIT_GB = 4;
const SESSION_TTL_DAYS = 30;

// ── Utilities ─────────────────────────────────────────────────────────────────
const getCurrentDateString = () => new Date().toISOString().split('T')[0];

const subDays = (dateStr, days) => {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

const pathExists = async (p) => {
  try { await fs.promises.access(p); return true; } catch { return false; }
};

const getFolderSize = async (dir) => {
  let size = 0;
  const files = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) size += await getFolderSize(fullPath);
    else size += (await fs.promises.stat(fullPath)).size;
  }
  return size;
};

// #8 FIX: Push notifications — siempre buscar por username lowercase
const sendPushNotification = async (username, payload) => {
  const key = username.toLowerCase();
  const subs = db.prepare('SELECT subscription FROM push_subscriptions WHERE username = ?').all(key);
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.subscription), JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE subscription = ?').run(s.subscription);
        log('INFO', `[Push] Suscripción expirada eliminada para ${key}`);
      }
    }
  }
};

// ── Chat History ──────────────────────────────────────────────────────────────
async function saveMessageWithRotation(roomId, message) {
  const today = getCurrentDateString();
  const dayPath = path.join(CHAT_HISTORY_DIR, today);
  await fs.promises.mkdir(dayPath, { recursive: true });
  await fs.promises.appendFile(
    path.join(dayPath, `${roomId}.jsonl`),
    JSON.stringify(message) + '\n'
  );

  const cutoffDate = subDays(today, CHAT_RETENTION_DAYS);
  const cutoffPath = path.join(CHAT_HISTORY_DIR, cutoffDate);
  const uploadsCutoffPath = path.join(UPLOAD_DIR, cutoffDate);

  if (await pathExists(cutoffPath)) {
    await fs.promises.rm(cutoffPath, { recursive: true, force: true });
    log('INFO', `[Rotation] Historial eliminado para ${cutoffDate}`);
  }
  if (await pathExists(uploadsCutoffPath)) {
    await fs.promises.rm(uploadsCutoffPath, { recursive: true, force: true });
    log('INFO', `[Rotation] Uploads eliminados para ${cutoffDate}`);
  }
}

// ── Upload Limits ─────────────────────────────────────────────────────────────
async function checkDailyUploadLimit(newFileSize) {
  const todayDir = path.join(UPLOAD_DIR, getCurrentDateString());
  const maxDailyBytes = MAX_DAILY_UPLOAD_GB * 1024 ** 3;
  let currentSize = 0;
  if (await pathExists(todayDir)) currentSize = await getFolderSize(todayDir);
  if (currentSize + newFileSize > maxDailyBytes) throw new Error('DAILY_LIMIT_EXCEEDED');
}

async function checkHardLimit(newFileSize) {
  const hardLimitBytes = HARD_LIMIT_GB * 1024 ** 3;
  let totalSize = 0;
  if (await pathExists(UPLOAD_DIR)) totalSize = await getFolderSize(UPLOAD_DIR);
  if (totalSize + newFileSize > hardLimitBytes) {
    log('ERROR', '[HARD LIMIT] /uploads/chat/ superó 4GB — upload rechazado');
    throw new Error('HARD_LIMIT_EXCEEDED');
  }
}

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dest = path.join(UPLOAD_DIR, getCurrentDateString());
    await fs.promises.mkdir(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('INVALID_TYPE'));
  }
});

// ── In-Memory State ───────────────────────────────────────────────────────────
// #7 FIX: reactions y pin usan un Map en memoria (keyed by msgId)
const reactionsStore = new Map(); // msgId -> { emoji: [usernames] }
let pinnedMessage = null;
const typingTimers = new Map();

// ── DB Init ───────────────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    assignedTo TEXT,
    status TEXT DEFAULT 'pendiente',
    priority TEXT DEFAULT 'media',
    dueDate TEXT,
    tags TEXT,
    linkedProperty TEXT,
    createdAt TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    ticketId TEXT,
    author TEXT,
    content TEXT,
    timestamp TEXT,
    FOREIGN KEY(ticketId) REFERENCES tickets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    passwordHash TEXT NOT NULL,
    color TEXT NOT NULL,
    displayName TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    subscription TEXT,
    UNIQUE(username, subscription)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    messageId TEXT NOT NULL,
    emoji TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (messageId, emoji, username)
  );

  CREATE TABLE IF NOT EXISTS pinned_messages (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    messageJson TEXT
  );

  -- #2 FIX: sessions en SQLite para sobrevivir reinicios
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  );
`);

// Restaurar reacciones y pin desde DB al iniciar
(function restoreState() {
  const rows = db.prepare('SELECT messageId, emoji, username FROM reactions').all();
  for (const r of rows) {
    if (!reactionsStore.has(r.messageId)) reactionsStore.set(r.messageId, {});
    const reactions = reactionsStore.get(r.messageId);
    if (!reactions[r.emoji]) reactions[r.emoji] = [];
    reactions[r.emoji].push(r.username);
  }

  const pinRow = db.prepare('SELECT messageJson FROM pinned_messages WHERE id = 1').get();
  if (pinRow) {
    try { pinnedMessage = JSON.parse(pinRow.messageJson); } catch {}
  }
  log('INFO', `[Startup] ${reactionsStore.size} mensajes con reacciones restaurados`);
})();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// #3 FIX: Rate limiting en login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 15,
  message: { error: 'Demasiados intentos. Esperá 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Rutas estáticas públicas
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.use(express.static(path.join(__dirname, 'public')));

// #4 FIX: Uploads servidos con autenticación (no express.static directo)
app.get('/uploads/chat/:date/:filename', (req, res) => {
  const token = req.query.token || req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const session = db.prepare('SELECT username, expiresAt FROM sessions WHERE token = ?').get(token);
  if (!session || new Date(session.expiresAt) < new Date()) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  // #5 FIX: Sanitizar los path params para evitar path traversal
  const safeDate = req.params.date.replace(/[^0-9-]/g, '');
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, safeDate, safeFilename);

  // Verificar que el path resultante está dentro del UPLOAD_DIR
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) {
    return res.status(400).json({ error: 'Ruta inválida' });
  }

  res.sendFile(filePath);
});

// ── Auth Middleware ───────────────────────────────────────────────────────────
// #2 FIX: authenticate consulta DB en vez del Map en memoria
const authenticate = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const session = db.prepare('SELECT username, expiresAt FROM sessions WHERE token = ?').get(token);
  if (!session || new Date(session.expiresAt) < new Date()) {
    return res.status(401).json({ error: 'Sesión expirada. Volvé a ingresar.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(session.username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  req.user = { username: user.displayName, usernameKey: user.username, color: user.color };
  next();
};

// ── Login / Logout ────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const userKey = username?.toLowerCase();

  if (!userKey || !password) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(userKey);
    if (user && await bcrypt.compare(password, user.passwordHash)) {
      const token = uuidv4();
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // #2 FIX: guardar sesión en DB
      db.prepare('INSERT INTO sessions (token, username, createdAt, expiresAt) VALUES (?, ?, ?, ?)')
        .run(token, userKey, now, expires);

      // Limpiar sesiones viejas del mismo usuario (opcional)
      db.prepare('DELETE FROM sessions WHERE username = ? AND expiresAt < ?').run(userKey, now);

      log('INFO', `[Login] Usuario "${user.displayName}" autenticado`);
      return res.json({ token, user: { username: user.displayName, color: user.color } });
    }

    res.status(401).json({ error: 'Credenciales inválidas' });
  } catch (error) {
    log('ERROR', `[Login] ${error.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.json({ success: true });
});

// ── Push Key (sin auth — necesaria para el registro inicial del SW) ────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// #9 FIX: removido el endpoint duplicado /api/push-subscribe y /api/vapid-public-key
// Solo queda /api/push/vapid-public-key y /api/push/subscribe

app.post('/api/push/subscribe', authenticate, (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }
  try {
    // #8 FIX: guardar siempre en lowercase
    db.prepare('INSERT OR IGNORE INTO push_subscriptions (username, subscription) VALUES (?, ?)')
      .run(req.user.usernameKey, JSON.stringify(subscription));
    res.status(201).json({ success: true });
  } catch (error) {
    log('ERROR', `[Push Subscribe] ${error.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ── Tickets ───────────────────────────────────────────────────────────────────
app.get('/api/tickets', authenticate, (req, res) => {
  try {
    const tickets = db.prepare(`
      SELECT t.*,
        json_group_array(
          CASE WHEN c.id IS NOT NULL
          THEN json_object('id', c.id, 'author', c.author, 'content', c.content, 'timestamp', c.timestamp)
          ELSE NULL END
        ) as comments
      FROM tickets t
      LEFT JOIN comments c ON c.ticketId = t.id
      GROUP BY t.id
      ORDER BY t.createdAt DESC
    `).all();

    res.json(tickets.map(t => ({
      ...t,
      tags: t.tags ? JSON.parse(t.tags) : [],
      comments: t.comments ? JSON.parse(t.comments).filter(c => c !== null) : []
    })));
  } catch (error) {
    log('ERROR', `[GET /tickets] ${error.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/tickets', authenticate, (req, res) => {
  try {
    const { title, description, assignedTo, status, priority, dueDate, tags, linkedProperty } = req.body;
    if (!title) return res.status(400).json({ error: 'El título es requerido' });

    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO tickets (id, title, description, assignedTo, status, priority, dueDate, tags, linkedProperty, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, description, assignedTo, status || 'pendiente', priority || 'media', dueDate, JSON.stringify(tags || []), linkedProperty, now, now);

    const newTicket = { id, title, description, assignedTo, status: status || 'pendiente', priority: priority || 'media', dueDate, tags: tags || [], linkedProperty, createdAt: now, updatedAt: now, comments: [] };

    if (assignedTo) {
      io.emit('ticket_assigned', { ticket: newTicket, assignedTo });
      sendPushNotification(assignedTo, {
        title: '📋 Nuevo Ticket Asignado',
        body: `Se te asignó: ${title}`,
        tag: `ticket-${id}`
      }).catch(e => log('ERROR', `[Push] ${e.message}`));
    }

    res.status(201).json(newTicket);
  } catch (error) {
    log('ERROR', `[POST /tickets] ${error.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.put('/api/tickets/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, assignedTo, status, priority, dueDate, tags, linkedProperty } = req.body;
    const now = new Date().toISOString();

    const oldTicket = db.prepare('SELECT assignedTo FROM tickets WHERE id = ?').get(id);
    if (!oldTicket) return res.status(404).json({ error: 'Ticket no encontrado' });

    db.prepare(`
      UPDATE tickets
      SET title=?, description=?, assignedTo=?, status=?, priority=?, dueDate=?, tags=?, linkedProperty=?, updatedAt=?
      WHERE id=?
    `).run(title, description, assignedTo, status, priority, dueDate, JSON.stringify(tags || []), linkedProperty, now, id);

    const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);

    if (assignedTo && oldTicket.assignedTo !== assignedTo) {
      io.emit('ticket_assigned', {
        ticket: { ...updatedTicket, tags: updatedTicket.tags ? JSON.parse(updatedTicket.tags) : [] },
        assignedTo
      });
      sendPushNotification(assignedTo, {
        title: '📋 Ticket Asignado',
        body: `Se te asignó: ${title}`,
        tag: `ticket-${id}`
      }).catch(e => log('ERROR', `[Push] ${e.message}`));
    }

    res.json({ success: true });
  } catch (error) {
    log('ERROR', `[PUT /tickets/:id] ${error.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.delete('/api/tickets/:id', authenticate, (req, res) => {
  try {
    db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    log('ERROR', `[DELETE /tickets/:id] ${error.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/tickets/:id/comments', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Contenido requerido' });

    const commentId = uuidv4();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO comments (id, ticketId, author, content, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(commentId, id, req.user.username, content, now);

    res.status(201).json({ id: commentId, ticketId: id, author: req.user.username, content, timestamp: now });
  } catch (error) {
    log('ERROR', `[POST /comments] ${error.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ── Chat REST API ─────────────────────────────────────────────────────────────
app.get('/api/chat/history', authenticate, async (req, res) => {
  // #5 FIX: sanitizar room param para evitar path traversal
  const rawRoom = req.query.room || 'general';
  const room = rawRoom.replace(/[^a-zA-Z0-9_-]/g, '');
  const days = Math.min(parseInt(req.query.days) || CHAT_RETENTION_DAYS, CHAT_RETENTION_DAYS);

  const messagesList = [];
  const today = new Date();
  let oldestDate = null;

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const filePath = path.join(CHAT_HISTORY_DIR, dateStr, `${room}.jsonl`);

    if (await pathExists(filePath)) {
      if (!oldestDate) oldestDate = dateStr;
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim() !== '');
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          // Attach current reactions from memory
          if (reactionsStore.has(msg.id)) msg.reactions = reactionsStore.get(msg.id);
          messagesList.push(msg);
        } catch {}
      }
    }
  }

  res.json({ room, messages: messagesList, daysLoaded: days, oldestDate });
});

// #10 FIX: io.emit DENTRO del try, después del await save
app.post('/api/chat/message', authenticate, async (req, res) => {
  const { roomId = 'general', text, type = 'text', fileUrl, fileName, fileSize } = req.body;

  const msgId = uuidv4();
  const sanitizedText = text?.trim()?.replace(/</g, '&lt;').replace(/>/g, '&gt;') || '';

  const newMessage = {
    id: msgId,
    userId: req.user.usernameKey,
    userName: req.user.username,
    user: req.user.username,
    color: req.user.color,
    avatar: req.user.username.charAt(0).toUpperCase(),
    text: sanitizedText,
    timestamp: new Date().toISOString(),
    type,
    replyTo: req.body.replyTo || null,
    reactions: {}
  };

  if (type !== 'text') {
    newMessage.fileUrl = fileUrl;
    newMessage.fileName = fileName;
    newMessage.fileSize = fileSize;
  }

  try {
    // #10 FIX: primero guardar, luego emitir
    await saveMessageWithRotation(roomId, newMessage);
    io.emit('new_message', newMessage);
    res.status(201).json(newMessage);

    // Detect @mentions
    const mentionRegex = /@(\w+)/gi;
    const mentionedNames = [];
    let match;
    while ((match = mentionRegex.exec(sanitizedText)) !== null) {
      mentionedNames.push(match[1].toLowerCase());
    }

    const allUsers = db.prepare('SELECT username FROM users').all();
    for (const u of allUsers) {
      if (u.username === req.user.usernameKey) continue;

      const isMentioned = mentionedNames.includes(u.username);

      if (isMentioned) {
        sendPushNotification(u.username, {
          title: `🚨 ${newMessage.userName} te mencionó`,
          body: sanitizedText || 'Archivo adjunto',
          tag: `mention-${msgId}`,
          requireInteraction: true,
          vibrate: [400, 100, 400, 100, 400]
        }).catch(e => log('ERROR', `[Push] ${e.message}`));
      } else {
        sendPushNotification(u.username, {
          title: `💬 ${newMessage.userName}`,
          body: sanitizedText || 'Archivo adjunto',
          tag: 'chat',
          vibrate: [200, 100, 200]
        }).catch(e => log('ERROR', `[Push] ${e.message}`));
      }
    }
  } catch (error) {
    log('ERROR', `[POST /chat/message] ${error.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/chat/upload', authenticate, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.message === 'INVALID_TYPE') return res.status(400).json({ error: 'Tipo de archivo no permitido' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `El archivo supera el límite de ${MAX_UPLOAD_SIZE_MB} MB` });
      return res.status(400).json({ error: 'Error en la subida del archivo' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    try {
      await checkHardLimit(req.file.size);
      await checkDailyUploadLimit(req.file.size);

      const dateStr = getCurrentDateString();
      const fileUrl = `/uploads/chat/${dateStr}/${req.file.filename}`;
      const isImage = req.file.mimetype.startsWith('image/');

      log('INFO', `[Upload] ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(2)}MB) por ${req.user.username}`);

      res.json({
        fileId: req.file.filename.split('.')[0],
        url: fileUrl,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        type: isImage ? 'image' : 'file'
      });
    } catch (limitErr) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      if (limitErr.message === 'HARD_LIMIT_EXCEEDED') return res.status(507).json({ error: 'Almacenamiento del servidor lleno' });
      if (limitErr.message === 'DAILY_LIMIT_EXCEEDED') return res.status(429).json({ error: 'Límite diario alcanzado. Intentá mañana.' });
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
});

app.get('/api/admin/disk-usage', authenticate, async (req, res) => {
  try {
    const todayDir = path.join(UPLOAD_DIR, getCurrentDateString());
    let todayUsed = 0;
    let totalSize = 0;
    if (await pathExists(todayDir)) todayUsed = await getFolderSize(todayDir);
    if (await pathExists(UPLOAD_DIR)) totalSize = await getFolderSize(UPLOAD_DIR);

    const days = [];
    if (await pathExists(UPLOAD_DIR)) {
      const dirs = await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory()) {
          const sz = await getFolderSize(path.join(UPLOAD_DIR, d.name));
          days.push({ date: d.name, size_mb: parseFloat((sz / (1024 * 1024)).toFixed(2)) });
        }
      }
    }

    res.json({
      uploads_gb: parseFloat((totalSize / (1024 ** 3)).toFixed(4)),
      hard_limit_gb: HARD_LIMIT_GB,
      daily_limit_gb: MAX_DAILY_UPLOAD_GB,
      today_used_gb: parseFloat((todayUsed / (1024 ** 3)).toFixed(4)),
      days: days.sort((a, b) => b.date.localeCompare(a.date))
    });
  } catch (e) {
    log('ERROR', `[disk-usage] ${e.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Cron: Tickets que vencen hoy ─────────────────────────────────────────────
cron.schedule('0 9 * * *', () => {
  log('INFO', '[CRON] Revisando tickets que vencen hoy...');
  const today = getCurrentDateString();
  const dueTickets = db.prepare("SELECT * FROM tickets WHERE dueDate = ? AND status != 'listo'").all(today);

  for (const t of dueTickets) {
    if (t.assignedTo) {
      sendPushNotification(t.assignedTo, {
        title: '⏰ Ticket Vence Hoy',
        body: `"${t.title}" vence hoy`,
        tag: `due-${t.id}`
      }).catch(e => log('ERROR', `[CRON Push] ${e.message}`));
    }
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Auth via token en DB
  const token = socket.handshake.auth.token;
  if (!token) { socket.disconnect(true); return; }

  const session = db.prepare('SELECT username, expiresAt FROM sessions WHERE token = ?').get(token);
  if (!session || new Date(session.expiresAt) < new Date()) {
    socket.disconnect(true);
    return;
  }

  const userRec = db.prepare('SELECT * FROM users WHERE username = ?').get(session.username);
  if (!userRec) { socket.disconnect(true); return; }

  const user = { username: userRec.displayName, usernameKey: userRec.username, color: userRec.color };
  log('INFO', `[Socket] ${user.username} conectado (${socket.id})`);

  socket.emit('initial_state', { pinnedMessage });

  // Typing
  socket.on('typing', (data) => {
    socket.broadcast.emit('user_typing', { username: user.username, isTyping: !!data.isTyping });

    if (data.isTyping) {
      if (typingTimers.has(user.username)) clearTimeout(typingTimers.get(user.username));
      typingTimers.set(user.username, setTimeout(() => {
        socket.broadcast.emit('user_typing', { username: user.username, isTyping: false });
        typingTimers.delete(user.username);
      }, 3000));
    } else {
      if (typingTimers.has(user.username)) {
        clearTimeout(typingTimers.get(user.username));
        typingTimers.delete(user.username);
      }
    }
  });

  // #7 FIX: Pin message — persiste en SQLite
  socket.on('pin_message', (data) => {
    const { messageId } = data;
    if (!messageId) {
      pinnedMessage = null;
      db.prepare('DELETE FROM pinned_messages WHERE id = 1').run();
    } else {
      // El mensaje viene del historial JSONL; el cliente debe enviar el objeto completo
      // Aquí sólo almacenamos el ID y esperamos que el cliente mande { messageId, message }
      if (data.message) {
        pinnedMessage = data.message;
        db.prepare('INSERT OR REPLACE INTO pinned_messages (id, messageJson) VALUES (1, ?)').run(JSON.stringify(pinnedMessage));
      }
    }
    io.emit('message_pinned', { message: pinnedMessage });
  });

  // #7 FIX: Reactions — persiste en SQLite + reactionsStore en memoria
  socket.on('add_reaction', (data) => {
    const { messageId, emoji } = data;
    if (!messageId || !emoji) return;

    if (!reactionsStore.has(messageId)) reactionsStore.set(messageId, {});
    const reactions = reactionsStore.get(messageId);

    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(user.username);

    if (idx === -1) {
      reactions[emoji].push(user.username);
      db.prepare('INSERT OR IGNORE INTO reactions (messageId, emoji, username) VALUES (?, ?, ?)').run(messageId, emoji, user.username);
    } else {
      reactions[emoji].splice(idx, 1);
      db.prepare('DELETE FROM reactions WHERE messageId = ? AND emoji = ? AND username = ?').run(messageId, emoji, user.username);
      if (reactions[emoji].length === 0) delete reactions[emoji];
    }

    io.emit('reaction_updated', { messageId, reactions });
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit('user_typing', { username: user.username, isTyping: false });
    log('INFO', `[Socket] ${user.username} desconectado`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  log('INFO', `Server running on port ${PORT}`);
});
