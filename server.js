require('dotenv').config();
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Init SQLite (built-in node:sqlite, no native compilation needed)
const db = new DatabaseSync(path.join(DATA_DIR, 'noteflow.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#5B8AF5'
  );

  CREATE TABLE IF NOT EXISTS notes (
    id          TEXT PRIMARY KEY,
    title       TEXT DEFAULT '',
    content     TEXT DEFAULT '',
    projectId   TEXT,
    tags        TEXT DEFAULT '[]',
    contentType TEXT DEFAULT 'note',
    createdAt   TEXT NOT NULL,
    updatedAt   TEXT NOT NULL,
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE SET NULL
  );
`);

// Seed sample data on first run
const seedDefaults = () => {
  const row = db.prepare('SELECT COUNT(*) AS c FROM projects').get();
  if (row.c > 0) return;

  const addProject = db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)');
  addProject.run('p1', 'Work', '#5B8AF5');
  addProject.run('p2', 'Personal', '#52C27E');
  addProject.run('p3', 'Research', '#E07B4F');

  const addNote = db.prepare(`
    INSERT INTO notes (id, title, content, projectId, tags, contentType, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();

  addNote.run('n1', 'Sprint planning notes',
    '## Sprint 14 Planning\n\nDiscussed with team:\n- **Auth refactor** due next week\n- New onboarding flow in design review\n- Bug fixes from QA list\n\n> Priority: ship the auth changes before anything else\n\n```\ntickets: [AUTH-12, OB-5, BUG-44]\n```',
    'p1', JSON.stringify(['meeting', 'sprint']), 'note',
    new Date(now - 7200000).toISOString(), new Date(now - 7200000).toISOString()
  );
  addNote.run('n2', 'Claude output: API design',
    "Here's a suggested API structure for the user service:\n\n```typescript\ninterface UserService {\n  getUser(id: string): Promise<User>;\n  updateUser(id: string, data: Partial<User>): Promise<User>;\n  deleteUser(id: string): Promise<void>;\n}\n```\n\nThe key design decisions:\n1. Async-first with Promises\n2. Partial updates via Partial<T>\n3. Explicit return types",
    'p1', JSON.stringify(['ai', 'architecture']), 'ai',
    new Date(now - 3600000).toISOString(), new Date(now - 3600000).toISOString()
  );
  addNote.run('n3', 'Research: note-taking patterns',
    '## Literature review notes\n\nFound interesting studies on PKM (Personal Knowledge Management):\n\n- Zettelkasten method by Luhmann\n- Building a Second Brain (Forte)\n- Evergreen notes (Matuschak)\n\n> The key insight: notes should link to each other, not just be stored.',
    'p3', JSON.stringify(['research', 'pkm']), 'note',
    new Date(now - 86400000).toISOString(), new Date(now - 86400000).toISOString()
  );
};

seedDefaults();

const parseNote = (row) => row ? { ...row, tags: JSON.parse(row.tags || '[]') } : null;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Projects ──────────────────────────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  res.json(db.prepare('SELECT * FROM projects').all());
});

app.post('/api/projects', (req, res) => {
  const { id, name, color } = req.body;
  try {
    db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(id, name, color);
    res.status(201).json({ id, name, color });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Notes ─────────────────────────────────────────────────────────────────────

app.get('/api/notes', (req, res) => {
  const rows = db.prepare('SELECT * FROM notes ORDER BY updatedAt DESC').all();
  res.json(rows.map(parseNote));
});

app.post('/api/notes', (req, res) => {
  const { id, title, content, projectId, tags, contentType, createdAt, updatedAt } = req.body;
  try {
    db.prepare(`
      INSERT INTO notes (id, title, content, projectId, tags, contentType, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title || '', content || '', projectId || null,
           JSON.stringify(tags || []), contentType || 'note', createdAt, updatedAt);
    res.status(201).json(parseNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/notes/:id', (req, res) => {
  const { title, content, projectId, tags, contentType, updatedAt } = req.body;
  try {
    db.prepare(`
      UPDATE notes SET title=?, content=?, projectId=?, tags=?, contentType=?, updatedAt=?
      WHERE id=?
    `).run(title || '', content || '', projectId || null,
           JSON.stringify(tags || []), contentType || 'note', updatedAt, req.params.id);
    res.json(parseNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/notes/:id', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── AI Proxy ──────────────────────────────────────────────────────────────────
// API keys live here on the server — never sent to the browser.
// Priority: ANTHROPIC_API_KEY first, then OPENROUTER_API_KEY.

function activeProvider() {
  if (process.env.ANTHROPIC_API_KEY)  return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return null;
}

async function callAnthropic(prompt) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic error ${res.status}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

async function callOpenRouter(prompt) {
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'NoteFlow',
    },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenRouter error ${res.status}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

// Tell the frontend which provider (and model) is active
app.get('/api/provider', (req, res) => {
  const provider = activeProvider();
  if (!provider) return res.json({ provider: null, model: null });
  const model = provider === 'anthropic'
    ? (process.env.ANTHROPIC_MODEL  || 'claude-haiku-4-5-20251001')
    : (process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku');
  res.json({ provider, model });
});

app.post('/api/ai/complete', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const provider = activeProvider();
  if (!provider) {
    return res.status(503).json({
      error: 'No AI key configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in your .env file.',
    });
  }

  try {
    const text = provider === 'anthropic'
      ? await callAnthropic(prompt)
      : await callOpenRouter(prompt);
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`NoteFlow running at http://localhost:${PORT}`);
  const provider = activeProvider();
  if (!provider) {
    console.warn('  ⚠  No AI key found — set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env');
  } else if (provider === 'anthropic') {
    console.log(`  ✓  AI provider: Anthropic (${process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'})`);
  } else {
    console.log(`  ✓  AI provider: OpenRouter (${process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku'})`);
  }
});
