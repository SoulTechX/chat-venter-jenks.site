// setup-users.js
// Crea o actualiza todos los usuarios con contraseñas encriptadas (bcrypt).
// Ejecutar desde la consola del contenedor en EasyPanel: node setup-users.js

const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SALT_ROUNDS = 12;

// En producción la DB está en /data/chat/tickets.db
// En desarrollo local está en ./data/tickets.db
const DATA_DIR = process.env.CHAT_HISTORY_DIR
  ? '/app/data'
  : path.join(__dirname, 'data');

const DB_PATH = path.join(DATA_DIR, 'tickets.db');

// ─── USUARIOS Y CONTRASEÑAS ──────────────────────────────────────────────────
// Modificar aquí si necesitás cambiar contraseñas en el futuro
const USERS = [
  { username: 'mati',   password: 'matih1',   displayName: 'Mati',   color: '#4A90D9' },
  { username: 'ema',    password: 'emavj1',   displayName: 'Ema',    color: '#27AE60' },
  { username: 'gesi',   password: 'gesih3',   displayName: 'Gesi',   color: '#E67E22' },
  { username: 'guille', password: 'guillea4', displayName: 'Guille', color: '#E74C3C' },
];
// ─────────────────────────────────────────────────────────────────────────────

async function setupUsers() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      passwordHash TEXT NOT NULL,
      color TEXT NOT NULL,
      displayName TEXT NOT NULL
    );
  `);

  console.log('\n🔐 Configurando usuarios...\n');

  for (const user of USERS) {
    const hash = await bcrypt.hash(user.password, SALT_ROUNDS);
    db.prepare(`
      INSERT INTO users (username, passwordHash, color, displayName)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        passwordHash = excluded.passwordHash,
        displayName  = excluded.displayName,
        color        = excluded.color
    `).run(user.username, hash, user.color, user.displayName);

    console.log(`  ✅ ${user.displayName} (${user.username}) → contraseña actualizada`);
  }

  console.log('\n🎉 ¡Listo! Todos los usuarios están configurados.\n');
  db.close();
}

setupUsers().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
