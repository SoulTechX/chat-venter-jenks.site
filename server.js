const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

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

const USERS = {
  'mati': { username: 'Mati', color: '#4A90D9' },
  'gise': { username: 'Gise', color: '#E67E22' },
  'ema':  { username: 'Ema',  color: '#27AE60' },
  'guille': { username: 'Guille', color: '#E74C3C' }
};

// --- In-Memory State ---
const sessions = new Map(); // token -> username
let messages = [];
let pinnedMessage = null;
const typingTimers = new Map();

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
`);

// --- Middleware ---
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Simple Auth Middleware for API
const authenticate = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (token && sessions.has(token)) {
    req.user = USERS[sessions.get(token).toLowerCase()];
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// --- REST API ---

// Auth
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const userKey = username?.toLowerCase();
  
  // Hardcoded check: accept if username exists in USERS and password is not empty
  if (USERS[userKey] && password) {
    const token = uuidv4();
    sessions.set(token, userKey);
    res.json({ token, user: USERS[userKey] });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (token) {
    sessions.delete(token);
  }
  res.json({ success: true });
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

// --- Socket.io Real-time Chat ---
io.on('connection', (socket) => {
  // Authentication on socket connection
  const token = socket.handshake.auth.token;
  if (!token || !sessions.has(token)) {
    socket.disconnect(true);
    return;
  }
  
  const userKey = sessions.get(token);
  const user = USERS[userKey];
  
  // Send current state
  socket.emit('initial_state', {
    messages,
    pinnedMessage
  });
  
  socket.on('send_message', (data) => {
    // Sanitize input
    const text = data.text?.trim()?.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (!text) return;
    
    const msgId = uuidv4();
    const newMessage = {
      id: msgId,
      user: user.username,
      text: text,
      color: user.color,
      avatar: user.username.charAt(0).toUpperCase(),
      timestamp: new Date().toISOString(),
      replyTo: data.replyTo || null,
      reactions: {} // { emoji: [usernames] }
    };
    
    messages.push(newMessage);
    
    // Memory limit: keep last 500 messages
    if (messages.length > 500) {
      messages.shift();
    }
    
    io.emit('new_message', newMessage);
  });
  
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
