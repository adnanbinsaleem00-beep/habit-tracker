const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { URL } = require('url');

// Connect to our PostgreSQL database using the URL Render gives us.
// This URL is provided as an environment variable called DATABASE_URL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS habits (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT false
    )
  `);
}

const sessions = {};

function createSession(username) {
  const sessionId = crypto.randomBytes(24).toString('hex');
  sessions[sessionId] = username;
  return sessionId;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const result = {};
  header.split(';').forEach((part) => {
    const [key, ...rest] = part.trim().split('=');
    if (key) result[key] = rest.join('=');
  });
  return result;
}

function getUsernameFromRequest(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.sessionId;
  if (sessionId && sessions[sessionId]) {
    return sessions[sessionId];
  }
  return null;
}

async function getUserByUsername(username) {
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0] || null;
}

async function renderHabitList(userId) {
  const result = await pool.query('SELECT * FROM habits WHERE user_id = $1 ORDER BY id', [userId]);
  const habits = result.rows;
  if (habits.length === 0) {
    return '<p>No habits yet. Add one below!</p>';
  }
  return `
    <ul class="habit-list">
      ${habits.map((habit) => {
        const checked = habit.done ? 'checked' : '';
        return `
          <li class="habit">
            <label>
              <input type="checkbox" ${checked} onchange="toggleHabit(${habit.id})" />
              <span>${habit.name}</span>
            </label>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

function wrapPage(title, bodyHtml) {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${title}</title>
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: #15161a;
            color: #e8e8ea;
            max-width: 480px;
            margin: 60px auto;
            padding: 0 20px;
            line-height: 1.5;
          }
          h1 {
            font-size: 26px;
            font-weight: 700;
            margin-bottom: 28px;
            letter-spacing: -0.3px;
          }
          ul.habit-list { list-style: none; padding: 0; margin: 0; }
          li.habit {
            background: #1f2025;
            border: 1px solid #2a2b31;
            border-radius: 14px;
            padding: 16px 18px;
            margin-bottom: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
            transition: border-color 0.15s ease;
          }
          li.habit:hover {
            border-color: #3a3b42;
          }
          li.habit label {
            display: flex;
            align-items: center;
            gap: 14px;
            cursor: pointer;
            font-size: 16px;
          }
          input[type="checkbox"] {
            width: 20px;
            height: 20px;
            accent-color: #6c5ce7;
            cursor: pointer;
            flex-shrink: 0;
          }
          form { display: flex; flex-direction: column; gap: 14px; margin-top: 20px; }
          form.inline { flex-direction: row; margin-top: 24px; }
          input[type="text"], input[type="password"] {
            padding: 12px 14px;
            font-size: 15px;
            background: #1f2025;
            border: 1px solid #2a2b31;
            border-radius: 10px;
            color: #e8e8ea;
            flex: 1;
            outline: none;
            transition: border-color 0.15s ease;
          }
          input[type="text"]:focus, input[type="password"]:focus {
            border-color: #6c5ce7;
          }
          input::placeholder { color: #6b6c74; }
          button {
            padding: 12px 20px;
            font-size: 15px;
            font-weight: 600;
            background: #6c5ce7;
            color: white;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            transition: background 0.15s ease;
          }
          button:hover { background: #5a4bd4; }
          .error {
            color: #ff6b6b;
            margin-bottom: 12px;
            font-size: 14px;
          }
          a {
            color: #9b8cff;
            text-decoration: none;
          }
          a:hover { text-decoration: underline; }
          .topbar {
            margin-bottom: 28px;
            font-size: 13px;
            color: #8b8c94;
          }
          p { color: #b4b5bd; }
        </style>
      </head>
      <body>
        ${bodyHtml}
      </body>
    </html>
  `;
}