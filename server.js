const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { URL } = require('url');

const db = new Database('habits.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  )
`);

// Habits now have a user_id column, linking each habit to its owner.
db.exec(`
  CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

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

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

// Renders the habit list for a SPECIFIC user only.
function renderHabitList(userId) {
  const habits = db.prepare('SELECT * FROM habits WHERE user_id = ?').all(userId);
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
          body {
            font-family: -apple-system, Arial, sans-serif;
            background: #fafafa;
            color: #222;
            max-width: 480px;
            margin: 60px auto;
            padding: 0 20px;
          }
          h1 { font-size: 24px; margin-bottom: 24px; }
          ul.habit-list { list-style: none; padding: 0; }
          li.habit {
            background: white;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 14px 16px;
            margin-bottom: 10px;
          }
          li.habit label {
            display: flex;
            align-items: center;
            gap: 12px;
            cursor: pointer;
            font-size: 16px;
          }
          input[type="checkbox"] { width: 18px; height: 18px; }
          form { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
          form.inline { flex-direction: row; margin-top: 20px; }
          input[type="text"], input[type="password"] {
            padding: 10px;
            font-size: 16px;
            border: 1px solid #ccc;
            border-radius: 6px;
            flex: 1;
          }
          button {
            padding: 10px 16px;
            font-size: 16px;
            background: #222;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
          }
          .error { color: #c0392b; margin-bottom: 12px; }
          a { color: #222; }
          .topbar { margin-bottom: 20px; font-size: 14px; }
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

function renderLoggedInHomePage(user) {
  return wrapPage('My Habit Tracker', `
    <div class="topbar">Logged in as <strong>${user.username}</strong> | <a href="/logout">Log Out</a></div>
    <h1>My Habit Tracker</h1>
    ${renderHabitList(user.id)}
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  const username = getUsernameFromRequest(req);
  const currentUser = username ? getUserByUsername(username) : null;

  // Add a new habit (must be logged in)
  if (req.method === 'POST' && url.pathname === '/habits/add') {
    readFormData(req, (params) => {
      if (!currentUser) {
        redirectTo(res, '/login');
        return;
      }
      const name = params.get('name');
      if (name && name.trim()) {
        db.prepare('INSERT INTO habits (user_id, name, done) VALUES (?, ?, 0)').run(currentUser.id, name.trim());
      }
      redirectTo(res, '/');
    });
    return;
  }

  // Toggle a habit (must own the habit)
  if (req.method === 'POST' && url.pathname.startsWith('/toggle/')) {
    const id = url.pathname.split('/toggle/')[1];
    if (currentUser) {
      const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(id, currentUser.id);
      if (habit) {
        const newDone = habit.done ? 0 : 1;
        db.prepare('UPDATE habits SET done = ? WHERE id = ?').run(newDone, id);
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
    readFormData(req, (params) => {
      const newUsername = params.get('username');
      const password = params.get('password');
      if (!newUsername || !password) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderSignupPage('Please fill in both fields.'));
        return;
      }
      const existing = getUserByUsername(newUsername);
      if (existing) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderSignupPage('That username is already taken.'));
        return;
      }
      const hashedPassword = bcrypt.hashSync(password, 10);
      db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(newUsername, hashedPassword);
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
    readFormData(req, (params) => {
      const loginUsername = params.get('username');
      const password = params.get('password');
      const user = getUserByUsername(loginUsername);
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
    res.end(currentUser ? renderLoggedInHomePage(currentUser) : renderLoggedOutHomePage());
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Page not found');
});

server.listen(3000, () => {
  console.log('Server running! Open your browser to http://localhost:3000');
});