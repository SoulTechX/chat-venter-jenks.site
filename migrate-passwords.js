// migrate-passwords.js
// INSTRUCCIONES:
// 1. Crear un archivo .env.migration con las contraseñas reales (ver formato abajo)
// 2. Ejecutar: node migrate-passwords.js
// 3. Verificar que el login funciona correctamente
// 4. ELIMINAR .env.migration inmediatamente después
// 5. ELIMINAR o deshabilitar este script después de la migración

require('dotenv').config({ path: '.env.migration' });
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SALT_ROUNDS = 12;

// Adaptado para usar la base de datos SQLite existente (en /app/data/tickets.db localmente ./data/tickets.db)
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'tickets.db');

async function migratePasswords() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  
  // Asegurar que la tabla users exista (el sistema original los tenía en memoria, ahora deben estar en DB)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      passwordHash TEXT NOT NULL,
      color TEXT NOT NULL,
      displayName TEXT NOT NULL
    );
  `);

  const usersInfo = {
    'mati': { username: 'Mati', color: '#4A90D9' },
    'gise': { username: 'Gise', color: '#E67E22' },
    'ema':  { username: 'Ema',  color: '#27AE60' },
    'guille': { username: 'Guille', color: '#E74C3C' }
  };

  const users = [
    { username: 'mati',   password: process.env.PASS_MATI },
    { username: 'ema',    password: process.env.PASS_EMA },
    { username: 'gise',   password: process.env.PASS_GISE },
    { username: 'guille', password: process.env.PASS_GUILLE },
  ];
  
  console.log('Starting password migration...\n');
  
  for (const user of users) {
    if (!user.password) {
      console.error(`❌ Missing password for user: ${user.username} in .env.migration`);
      process.exit(1);
    }
    
    const hash = await bcrypt.hash(user.password, SALT_ROUNDS);
    const info = usersInfo[user.username];
    
    // Insert or update
    const stmt = db.prepare(`
      INSERT INTO users (username, passwordHash, color, displayName) 
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET passwordHash=excluded.passwordHash
    `);
    
    stmt.run(user.username, hash, info.color, info.username);
    
    console.log(`✅ ${user.username}: hash generated and saved (${SALT_ROUNDS} rounds)`);
  }
  
  console.log('\n✅ Migration complete. Delete .env.migration now!');
}

migratePasswords().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
