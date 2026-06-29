const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { URL } = require('url');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function setupDatabase() {
  await pool.query('DROP TABLE IF EXISTS completions');
  await pool.query('DROP TABLE IF EXISTS habits CASCADE');

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
      name TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS completions (
      id SERIAL PRIMARY KEY,
      habit_id INTEGER NOT NULL REFERENCES habits(id),
      completed_on DATE NOT NULL,
      UNIQUE (habit_id, completed_on)
    )
  `);
}

function todayDateString() {
  return new Date().toISOString().split('T')[0];
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
  const today = todayDateString();

  const habitsResult = await pool.query('SELECT * FROM habits WHERE user_id = $1 ORDER BY id', [userId]);
  const habits = habitsResult.rows;

  if (habits.length === 0) {
    return '<p>No habits yet. Add one below!</p>';
  }

  const rows = await Promise.all(habits.map(async (habit) => {
    const todayResult = await pool.query(
      'SELECT * FROM completions WHERE habit_id = $1 AND completed_on = $2',
      [habit.id, today]
    );
    const doneToday = todayResult.rows.length > 0;

    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM completions WHERE habit_id = $1',
      [habit.id]
    );
    const totalCount = countResult.rows[0].count;

    const checked = doneToday ? 'checked' : '';
    return `
      <li class="habit">
        <label>
          <input type="checkbox" ${checked} onchange="toggleHabit(${habit.id})" />
          <span>${habit.name}</span>
        </label>
        <div class="habit-meta">Completed ${totalCount} day${totalCount === '1' ? '' : 's'} total</div>
      </li>
    `;
  }));

  return `<ul class="habit-list">${rows.join('')}</ul>`;
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
            margin-bottom: 6px;
            letter-spacing: -0.3px;
          }
          .date-label {
            color: #6b6c74;
            font-size: 14px;
            margin-bottom: 24px;
          }
          ul.habit-list { list-style: none; padding: 0; margin: 0; }
          li.habit {
            background: #1f2025;
            border: 1px solid #2a2b31;
            border-radius: 14px;
            padding: 16px 18px;
            margin-bottom: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
          }
          li.habit label {
            display: flex;
            align-items: center;
            gap: 14px;
            cursor: pointer;
            font-size: 16px;
          }
          .habit-meta {
            margin-top: 8px;
            margin-left: 34px;
            font-size: 12px;
            color: #6b6c74;
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

function renderLoggedOutHomePage() {
  return wrapPage('My Habit Tracker', `
    <div class="topbar"><a href="/signup">Sign Up</a> | <a href="/login">Log In</a></div>
    <h1>My Habit Tracker</h1>
    <p>Sign up or log in to start tracking your habits.</p>
  `);
}

async function renderLoggedInHomePage(user) {
  const today = new Date();
  const dateLabel = today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return wrapPage('My Habit Tracker', `
    <div class="topbar">Logged in as <strong>${user.username}</strong> | <a href="/logout">Log Out</a></div>
    <h1>My Habit Tracker</h1>
    <div class="date-label">${dateLabel}</div>
    ${await renderHabitList(user.id)}
    <form class="inline" method="POST" action="/habits/add">
      <input type="text" name="name" placeholder="New habit name" required />
      <button type="submit">Add</button>
    </form>
    <script>
      function toggleHabit(id) {
        fetch('/toggle/' + id, { method: 'POST' });
      }
    </script>
  `);
}

function renderSignupPage(error) {
  return wrapPage('Sign Up', `
    <h1>Sign Up</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="POST" action="/signup">
      <input type="text" name="username" placeholder="Username" required />
      <input type="password" name="password" placeholder="Password" required />
      <button type="submit">Create Account</button>
    </form>
    <p><a href="/">Back home</a></p>
  `);
}

function renderLoginPage(error) {
  return wrapPage('Log In', `
    <h1>Log In</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="POST" action="/login">
      <input type="text" name="username" placeholder="Username" required />
      <input type="password" name="password" placeholder="Password" required />
      <button type="submit">Log In</button>
    </form>
    <p><a href="/">Back home</a></p>
  `);
}

function readFormData(req, callback) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const params = new URLSearchParams(body);
    callback(params);
  });
}

function logUserInAndRedirect(res, username, redirectTo) {
  const sessionId = createSession(username);
  res.writeHead(302, {
    'Set-Cookie': `sessionId=${sessionId}; HttpOnly; Path=/`,
    'Location': redirectTo,
  });
  res.end();
}

function redirectTo(res, location) {
  res.writeHead(302, { 'Location': location });
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:3000');
    const username = getUsernameFromRequest(req);
    const currentUser = username ? await getUserByUsername(username) : null;

    if (req.method === 'POST' && url.pathname === '/habits/add') {
      readFormData(req, async (params) => {
        if (!currentUser) {
          redirectTo(res, '/login');
          return;
        }
        const name = params.get('name');
        if (name && name.trim()) {
          await pool.query('INSERT INTO habits (user_id, name) VALUES ($1, $2)', [currentUser.id, name.trim()]);
        }
        redirectTo(res, '/');
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/toggle/')) {
      const id = url.pathname.split('/toggle/')[1];
      if (currentUser) {
        const habitResult = await pool.query('SELECT * FROM habits WHERE id = $1 AND user_id = $2', [id, currentUser.id]);
        const habit = habitResult.rows[0];
        if (habit) {
          const today = todayDateString();
          const existing = await pool.query(
            'SELECT * FROM completions WHERE habit_id = $1 AND completed_on = $2',
            [id, today]
          );
          if (existing.rows.length > 0) {
            await pool.query('DELETE FROM completions WHERE habit_id = $1 AND completed_on = $2', [id, today]);
          } else {
            await pool.query('INSERT INTO completions (habit_id, completed_on) VALUES ($1, $2)', [id, today]);
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/signup') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderSignupPage());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/signup') {
      readFormData(req, async (params) => {
        const newUsername = params.get('username');
        const password = params.get('password');
        if (!newUsername || !password) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderSignupPage('Please fill in both fields.'));
          return;
        }
        const existing = await getUserByUsername(newUsername);
        if (existing) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderSignupPage('That username is already taken.'));
          return;
        }
        const hashedPassword = bcrypt.hashSync(password, 10);
        await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [newUsername, hashedPassword]);
        logUserInAndRedirect(res, newUsername, '/');
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderLoginPage());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      readFormData(req, async (params) => {
        const loginUsername = params.get('username');
        const password = params.get('password');
        const user = await getUserByUsername(loginUsername);
        if (!user || !bcrypt.compareSync(password, user.password)) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderLoginPage('Incorrect username or password.'));
          return;
        }
        logUserInAndRedirect(res, loginUsername, '/');
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/logout') {
      const cookies = parseCookies(req);
      delete sessions[cookies.sessionId];
      res.writeHead(302, {
        'Set-Cookie': 'sessionId=; HttpOnly; Path=/; Max-Age=0',
        'Location': '/',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(currentUser ? await renderLoggedInHomePage(currentUser) : renderLoggedOutHomePage());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Page not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Something went wrong');
    }
  }
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  let connected = false;
  let attempts = 0;
  while (!connected && attempts < 10) {
    try {
      await setupDatabase();
      connected = true;
    } catch (err) {
      attempts++;
      console.log('Database not ready yet, retrying... (' + attempts + '/10)');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  server.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
  });
}

startServer();