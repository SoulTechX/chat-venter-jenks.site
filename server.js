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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- Constants & Config ---
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'tickets.db');

// --- VAPID Keys Setup ---
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  const generatedKeys = webpush.generateVAPIDKeys();
  vapidKeys.publicKey = generatedKeys.publicKey;
  vapidKeys.privateKey = generatedKeys.privateKey;
  console.log('--- NUEVAS CLAVES VAPID GENERADAS ---');
  console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
  console.log('Agrega estas claves a tu .env para persistencia.');
}

webpush.setVapidDetails(
  'mailto:soporte@venter-jenks.site',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// USERS migrated to database

// --- Env & Utils ---
const CHAT_HISTORY_DIR = process.env.CHAT_HISTORY_DIR || path.join(__dirname, 'data', 'chat');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads', 'chat');
const CHAT_RETENTION_DAYS = parseInt(process.env.CHAT_RETENTION_DAYS) || 5;

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

const sendPushNotification = async (username, payload) => {
  const subs = db.prepare('SELECT subscription FROM push_subscriptions WHERE username = ?').all(username);
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.subscription), JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE subscription = ?').run(s.subscription);
      }
    }
  }
};

// Se ejecuta CADA VEZ que se guarda un mensaje o archivo
async function saveMessageWithRotation(roomId, message) {
  const today = getCurrentDateString();
  
  // 1. Guardar el mensaje
  const dayPath = path.join(CHAT_HISTORY_DIR, today);
  await fs.promises.mkdir(dayPath, { recursive: true });
  await fs.promises.appendFile(
    path.join(dayPath, `${roomId}.jsonl`),
    JSON.stringify(message) + '\n'
  );
  
  // 2. Calcular qué día debe eliminarse
  const cutoffDate = subDays(today, CHAT_RETENTION_DAYS);
  const cutoffPath = path.join(CHAT_HISTORY_DIR, cutoffDate);
  const uploadsCutoffPath = path.join(UPLOAD_DIR, cutoffDate);
  
  // 3. Eliminar si existe
  if (await pathExists(cutoffPath)) {
    await fs.promises.rm(cutoffPath, { recursive: true, force: true });
    console.log(`[Chat Rotation] Deleted history for ${cutoffDate}`);
  }
  if (await pathExists(uploadsCutoffPath)) {
    await fs.promises.rm(uploadsCutoffPath, { recursive: true, force: true });
    console.log(`[Chat Rotation] Deleted uploads for ${cutoffDate}`);
  }
}

// --- File Upload Setup (Módulo 3) ---
const MAX_UPLOAD_SIZE_MB = parseFloat(process.env.MAX_UPLOAD_SIZE_MB) || 25;
const MAX_DAILY_UPLOAD_GB = parseFloat(process.env.MAX_DAILY_UPLOAD_GB) || 2;
const HARD_LIMIT_GB = 4;

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const today = getCurrentDateString();
    const dest = path.join(UPLOAD_DIR, today);
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
    const allowedImage = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const allowedDoc = [
      'application/pdf', 
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (allowedImage.includes(file.mimetype) || allowedDoc.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('INVALID_TYPE'));
    }
  }
});

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
    console.error('[HARD LIMIT] /uploads/chat/ exceeded 4GB — upload rejected');
    throw new Error('HARD_LIMIT_EXCEEDED');
  }
}

// --- In-Memory State ---
const sessions = new Map(); // token -> username
const typingTimers = new Map();
let pinnedMessage = null;

// --- DB Initialization ---
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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
`);

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads/chat', express.static(UPLOAD_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Simple Auth Middleware for API
const authenticate = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (token && sessions.has(token)) {
    const username = sessions.get(token).toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (user) {
      req.user = { username: user.displayName, color: user.color };
      next();
      return;
    }
  }
  res.status(401).json({ error: 'Unauthorized' });
};

// --- REST API ---

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const userKey = username?.toLowerCase();
  
  if (!userKey || !password) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(userKey);
    
    if (user) {
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (isValid) {
        const token = uuidv4();
        sessions.set(token, userKey);
        return res.json({ token, user: { username: user.displayName, color: user.color } });
      }
    }
    
    res.status(401).json({ error: 'Credenciales inválidas' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (token) {
    sessions.delete(token);
  }
  res.json({ success: true });
});

// Push
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push-subscribe', authenticate, (req, res) => {
  const { subscription } = req.body;
  try {
    db.prepare('INSERT OR IGNORE INTO push_subscriptions (username, subscription) VALUES (?, ?)')
      .run(req.user.username.toLowerCase(), JSON.stringify(subscription));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Tickets
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
    `).all();

    const formattedTickets = tickets.map(t => ({
      ...t,
      tags: t.tags ? JSON.parse(t.tags) : [],
      comments: t.comments ? JSON.parse(t.comments).filter(c => c !== null) : []
    }));
    
    res.json(formattedTickets);
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/tickets', authenticate, (req, res) => {
  try {
    const { title, description, assignedTo, status, priority, dueDate, tags, linkedProperty } = req.body;
    const id = uuidv4();
    const now = new Date().toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO tickets (id, title, description, assignedTo, status, priority, dueDate, tags, linkedProperty, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(id, title, description, assignedTo, status || 'pendiente', priority || 'media', dueDate, JSON.stringify(tags || []), linkedProperty, now, now);
    
    const newTicket = { id, title, description, assignedTo, status: status || 'pendiente', priority: priority || 'media', dueDate, tags: tags || [], linkedProperty, createdAt: now, updatedAt: now, comments: [] };
    
    // Notify if assigned
    if (assignedTo) {
      io.emit('ticket_assigned', { ticket: newTicket, assignedTo });
      sendPushNotification(assignedTo.toLowerCase(), {
        title: 'Nuevo Ticket',
        body: `Se te ha asignado el ticket: ${title}`,
        tag: 'ticket'
      }).catch(console.error);
    }
    
    res.status(201).json(newTicket);
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.put('/api/tickets/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, assignedTo, status, priority, dueDate, tags, linkedProperty } = req.body;
    const now = new Date().toISOString();
    
    // Get old ticket to check assignment changes
    const oldTicket = db.prepare('SELECT assignedTo FROM tickets WHERE id = ?').get(id);
    
    const stmt = db.prepare(`
      UPDATE tickets
      SET title = ?, description = ?, assignedTo = ?, status = ?, priority = ?, dueDate = ?, tags = ?, linkedProperty = ?, updatedAt = ?
      WHERE id = ?
    `);
    
    stmt.run(title, description, assignedTo, status, priority, dueDate, JSON.stringify(tags || []), linkedProperty, now, id);
    
    // Notify if newly assigned
    const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (assignedTo && (!oldTicket || oldTicket.assignedTo !== assignedTo)) {
      io.emit('ticket_assigned', { 
        ticket: { ...updatedTicket, tags: updatedTicket.tags ? JSON.parse(updatedTicket.tags) : [] }, 
        assignedTo 
      });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.delete('/api/tickets/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/tickets/:id/comments', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const commentId = uuidv4();
    const now = new Date().toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO comments (id, ticketId, author, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(commentId, id, req.user.username, content, now);
    
    res.status(201).json({ id: commentId, ticketId: id, author: req.user.username, content, timestamp: now });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- Chat REST API (Módulo 2) ---

app.get('/api/chat/history', authenticate, async (req, res) => {
  const { room = 'general', days = CHAT_RETENTION_DAYS } = req.query;
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
          messagesList.push(JSON.parse(line));
        } catch(e) {}
      }
    }
  }
  
  res.json({
    room,
    messages: messagesList,
    daysLoaded: parseInt(days),
    oldestDate
  });
});

app.post('/api/chat/message', authenticate, async (req, res) => {
  const { roomId = 'general', text, type = 'text', fileUrl, fileName, fileSize } = req.body;
  
  const msgId = uuidv4();
  const newMessage = {
    id: msgId,
    userId: req.user.username.toLowerCase(),
    userName: req.user.username,
    color: req.user.color,
    avatar: req.user.username.charAt(0).toUpperCase(),
    text: text?.trim()?.replace(/</g, "&lt;").replace(/>/g, "&gt;") || '',
    timestamp: new Date().toISOString(),
    type: type,
    replyTo: req.body.replyTo || null,
    reactions: {}
  };
  
  if (type !== 'text') {
    newMessage.fileUrl = fileUrl;
    newMessage.fileName = fileName;
    newMessage.fileSize = fileSize;
  }
  
  try {
    await saveMessageWithRotation(roomId, newMessage);
    io.emit('new_message', newMessage);
    res.status(201).json(newMessage);
    
    const allUsers = db.prepare('SELECT username FROM users').all();
    for (const u of allUsers) {
       if (u.username.toLowerCase() !== newMessage.userId.toLowerCase()) {
         sendPushNotification(u.username, {
            title: `Nuevo mensaje de ${newMessage.userName}`,
            body: newMessage.text || 'Archivo adjunto',
            tag: 'chat'
         }).catch(console.error);
       }
    }
  } catch (error) {
    console.error('Error saving message:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/chat/upload', authenticate, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.message === 'INVALID_TYPE') return res.status(400).json({ error: 'Tipo de archivo no permitido' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'El archivo supera el límite de 25 MB' });
      return res.status(400).json({ error: 'Error en la subida del archivo' });
    }
    
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    
    try {
      await checkHardLimit(req.file.size);
      await checkDailyUploadLimit(req.file.size);
      
      const fileUrl = `/uploads/chat/${getCurrentDateString()}/${req.file.filename}`;
      const isImage = req.file.mimetype.startsWith('image/');
      
      console.log(`[Upload] File saved: ${req.file.filename} (${(req.file.size/1024/1024).toFixed(2)}MB)`);
      
      res.json({
        fileId: req.file.filename.split('.')[0],
        url: fileUrl,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        type: isImage ? 'image' : 'file'
      });
      
    } catch (limitErr) {
      await fs.promises.unlink(req.file.path).catch(()=>{});
      if (limitErr.message === 'HARD_LIMIT_EXCEEDED') return res.status(507).json({ error: 'Almacenamiento del servidor lleno' });
      if (limitErr.message === 'DAILY_LIMIT_EXCEEDED') return res.status(429).json({ error: 'Límite diario de almacenamiento alcanzado. Intentá mañana.' });
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
});

app.get('/api/admin/disk-usage', authenticate, async (req, res) => {
  try {
    const todayDir = path.join(UPLOAD_DIR, getCurrentDateString());
    let todayUsed = 0;
    if (await pathExists(todayDir)) todayUsed = await getFolderSize(todayDir);
    
    let totalSize = 0;
    if (await pathExists(UPLOAD_DIR)) totalSize = await getFolderSize(UPLOAD_DIR);
    
    const days = [];
    if (await pathExists(UPLOAD_DIR)) {
      const dirs = await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory()) {
          const sz = await getFolderSize(path.join(UPLOAD_DIR, d.name));
          days.push({ date: d.name, size_mb: parseFloat((sz / (1024*1024)).toFixed(2)) });
        }
      }
    }
    
    res.json({
      uploads_gb: parseFloat((totalSize / (1024**3)).toFixed(4)),
      hard_limit_gb: HARD_LIMIT_GB,
      daily_limit_gb: MAX_DAILY_UPLOAD_GB,
      today_used_gb: parseFloat((todayUsed / (1024**3)).toFixed(4)),
      days: days.sort((a,b) => b.date.localeCompare(a.date))
    });
  } catch(e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Push Endpoints ---
app.get('/api/push/vapid-public-key', authenticate, (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', authenticate, (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }

  try {
    db.prepare(`
      INSERT OR IGNORE INTO push_subscriptions (username, subscription) 
      VALUES (?, ?)
    `).run(req.user.username, JSON.stringify(subscription));
    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Error saving subscription', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function sendPushNotification(username, payload) {
  const subs = db.prepare('SELECT subscription FROM push_subscriptions WHERE username = ?').all(username);
  
  for (const subRow of subs) {
    try {
      const sub = JSON.parse(subRow.subscription);
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE subscription = ?').run(subRow.subscription);
      }
    }
  }
}

// --- Cron Job (Daily Due Tickets) ---
cron.schedule('0 9 * * *', () => {
  console.log('[CRON] Running daily check for due tickets...');
  const today = getCurrentDateString();
  const dueTickets = db.prepare('SELECT * FROM tickets WHERE dueDate = ?').all(today);
  
  for (const t of dueTickets) {
    if (t.assignedTo && t.status !== 'listo') {
       sendPushNotification(t.assignedTo, {
         title: 'Ticket Vence Hoy',
         body: `El ticket "${t.title}" vence hoy.`,
         tag: 'ticket'
       }).catch(console.error);
    }
  }
}, { timezone: "America/Argentina/Buenos_Aires" });

io.on('connection', (socket) => {
  // Authentication on socket connection
  const token = socket.handshake.auth.token;
  if (!token || !sessions.has(token)) {
    socket.disconnect(true);
    return;
  }
  
  const userKey = sessions.get(token);
  const userRec = db.prepare('SELECT * FROM users WHERE username = ?').get(userKey);
  if (!userRec) {
    socket.disconnect(true);
    return;
  }
  const user = { username: userRec.displayName, color: userRec.color };
  
  // Send current state
  socket.emit('initial_state', {
    pinnedMessage
  });
  
  // Note: we removed socket.on('send_message') in favor of POST /api/chat/message
  
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
  
  socket.on('pin_message', (data) => {
    const { messageId } = data;
    if (!messageId) {
       pinnedMessage = null;
    } else {
       const msg = messages.find(m => m.id === messageId);
       if (msg) {
         pinnedMessage = msg;
       }
    }
    io.emit('message_pinned', { message: pinnedMessage });
  });
  
  socket.on('add_reaction', (data) => {
    const { messageId, emoji } = data;
    const msg = messages.find(m => m.id === messageId);
    
    if (msg && emoji) {
      if (!msg.reactions[emoji]) {
        msg.reactions[emoji] = [];
      }
      
      const userIndex = msg.reactions[emoji].indexOf(user.username);
      if (userIndex === -1) {
        msg.reactions[emoji].push(user.username);
      } else {
        // Toggle reaction off
        msg.reactions[emoji].splice(userIndex, 1);
        if (msg.reactions[emoji].length === 0) {
          delete msg.reactions[emoji];
        }
      }
      
      io.emit('reaction_updated', { messageId, reactions: msg.reactions });
    }
  });

  socket.on('disconnect', () => {
    // Optionally emit typing stopped just in case
    socket.broadcast.emit('user_typing', { username: user.username, isTyping: false });
  });
});

// Clear messages on startup/restart (as requested, memory only)
messages = [];
pinnedMessage = null;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
