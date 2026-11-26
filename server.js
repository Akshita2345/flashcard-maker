// server.js - simple JSON-file backend (no lowdb dependency)
const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const ejs = require('ejs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'flash-secret', resave: false, saveUninitialized: false }));

// --- Simple JSON DB implementation ---
const DB_FILE = path.join(__dirname, 'db.json');
let db = {
  users: [],
  flashcards: [],
  questions: [],
  choices: [],
  cards: [],                // simple front/back cards inside a flashcard (deck)
  scores: [],
  answers: []
};

async function loadDb() {
  try {
    const txt = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(txt || '{}');
    // merge defaults so older files still work
    db = Object.assign({
      users: [],
      flashcards: [],
      questions: [],
      choices: [],
      scores: [],
      answers: []
    }, parsed);
  } catch (err) {
    // if file doesn't exist or is invalid, initialize with defaults
    if (err.code === 'ENOENT') {
      await saveDb(); // create file with defaults
    } else {
      console.warn('Warning: failed to read db.json, reinitializing:', err.message);
      await saveDb();
    }
  }
}

async function saveDb() {
  // atomic-ish write: write to temp file then rename
  const tmp = DB_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmp, DB_FILE);
}

// --- Helpers (previous LowDB helpers preserved semantics) ---
function findUserByEmail(email) { return db.users.find(u => u.email === email); }
function findUserByToken(token) { return db.users.find(u => u.token === token); }
function findUserByUsername(username) { return db.users.find(u => u.username === username); }

// --- Routes (kept same as your LowDB Option 1) ---
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (findUserByEmail(email)) return res.status(400).json({ error: 'email already in use' });
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    db.users.push({ id, name: name || null, email, password_hash: hashed, points: 0 });
    await saveDb();
    res.json({ ok: true, id });
  } catch (e) {
    console.error('signup error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const token = uuidv4();
    user.token = token;
    await saveDb();
    res.json({ ok: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'no token' });
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'invalid token' });
  req.user = user;
  next();
}

app.post('/api/flashcards', authMiddleware, async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const id = uuidv4();
    db.flashcards.push({ id, user_id: req.user.id, title, description: description || null, created_at: new Date().toISOString() });
    await saveDb();
    res.json({ ok: true, id });
  } catch (e) {
    console.error('add flashcard error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// Add simple front/back cards to a flashcard (deck)
app.post('/api/flashcards/:id/cards', authMiddleware, async (req, res) => {
  try {
    const flashcardId = req.params.id;
    const { cards } = req.body; // expect array of { front, back }
    if (!Array.isArray(cards) || cards.length === 0) return res.status(400).json({ error: 'cards required' });
    for (const c of cards) {
      if (!c.front) continue;
      const cid = uuidv4();
      db.cards.push({ id: cid, flashcard_id: flashcardId, front: c.front, back: c.back || '', created_at: new Date().toISOString() });
    }
    await saveDb();
    res.json({ ok: true });
  } catch (e) {
    console.error('add cards error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/flashcards/:id/cards', authMiddleware, (req, res) => {
  const flashcardId = req.params.id;
  const rows = db.cards.filter(c => c.flashcard_id === flashcardId).map(c => ({ id: c.id, front: c.front, back: c.back }));
  res.json(rows);
});

// Submit answers for front/back cards. Expect answers: [{ cardId, answer }]
app.post('/api/flashcards/:id/cards/submit', authMiddleware, async (req, res) => {
  try {
    const flashcardId = req.params.id;
    const { answers } = req.body;
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers required' });
    let correct = 0;
    const sid = uuidv4();
    for (const a of answers) {
      const card = db.cards.find(c => c.id === a.cardId && c.flashcard_id === flashcardId);
      if (!card) continue;
      const expected = (card.back || '').toString().trim().toLowerCase();
      const given = (a.answer || '').toString().trim().toLowerCase();
      const is_correct = (expected.length>0 && expected === given) ? 1 : 0;
      if (is_correct) correct++;
      const aid = uuidv4();
      db.answers.push({ id: aid, score_id: sid, user_id: req.user.id, flashcard_id: flashcardId, card_id: card.id, given: a.answer || '', expected: card.back || '', is_correct, created_at: new Date().toISOString() });
    }
    const total = answers.length;
    db.scores.push({ id: sid, user_id: req.user.id, flashcard_id: flashcardId, score: correct, total, created_at: new Date().toISOString() });
    // award 1 point per correct (as requested)
    req.user.points = (req.user.points || 0) + correct;
    await saveDb();
    res.json({ correct, total, score_id: sid });
  } catch (e) {
    console.error('submit cards error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/flashcards', authMiddleware, (req, res) => {
  const rows = db.flashcards
    .filter(f => f.user_id === req.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 50);
  res.json(rows);
});

// EJS pages
function requireAuth(req, res, next) { if (!req.session.userId) return res.redirect('/login'); next(); }

app.get('/', (req, res) => { if (req.session && req.session.userId) { res.redirect('/dashboard'); } else { res.redirect('/login'); } });

app.get('/signup', (req, res) => { res.render('signup', { error: null }); });
app.post('/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.render('signup', { error: 'Enter username and password' });
    if (findUserByUsername(username)) return res.render('signup', { error: 'Username already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    db.users.push({ id, username, password_hash: hashed, points: 0 });
    await saveDb();
    req.session.userId = id;
    req.session.username = username;
    res.redirect('/dashboard');
  } catch (e) {
    res.render('signup', { error: 'Internal error' });
  }
});

app.get('/login', (req, res) => { res.render('login', { error: null }); });
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.render('login', { error: 'Enter username and password' });
    const user = findUserByUsername(username);
    if (!user) return res.render('login', { error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.render('login', { error: 'Invalid credentials' });
    req.session.userId = user.id;
    req.session.username = user.username;
    res.redirect('/dashboard');
  } catch (e) {
    res.render('login', { error: 'Internal error' });
  }
});

app.post('/logout', (req, res) => { req.session.destroy(() => { res.redirect('/login'); }); });

app.get('/dashboard', requireAuth, (req, res) => { res.render('dashboard', { username: req.session.username }); });

app.get('/deck/add', requireAuth, (req, res) => { res.render('add_deck', { step: 'init', deck: null, count: null, cards: [], error: null }); });
app.post('/deck/create-init', requireAuth, async (req, res) => {
  const { name, count } = req.body;
  const c = parseInt(count, 10);
  if (!name || !c || c < 1) return res.render('add_deck', { step: 'init', deck: null, count: null, cards: [], error: 'Enter a name and a positive number of cards' });
  const id = uuidv4();
  db.flashcards.push({ id, user_id: req.session.userId, title: name, description: null, created_at: new Date().toISOString() });
  await saveDb();
  const deck = { id, name };
  res.render('add_deck', { step: 'cards', deck, count: c, cards: [], error: null });
});
app.post('/deck/:id/cards/save', requireAuth, async (req, res) => {
  const deckId = req.params.id;
  const { questions = [], answers = [] } = req.body;
  const q = Array.isArray(questions) ? questions : [questions];
  const a = Array.isArray(answers) ? answers : [answers];
  if (q.length !== a.length || q.length === 0) return res.render('add_deck', { step: 'cards', deck: { id: deckId }, count: q.length, cards: [], error: 'Enter questions and answers' });
  for (let i = 0; i < q.length; i++) {
    const qq = String(q[i] || '').trim();
    const aa = String(a[i] || '').trim();
    if (!qq || !aa) continue;
    const cid = uuidv4();
    db.cards.push({ id: cid, flashcard_id: deckId, front: qq, back: aa, created_at: new Date().toISOString() });
  }
  await saveDb();
  const rows = db.cards.filter(c => c.flashcard_id === deckId);
  res.render('add_deck', { step: 'review', deck: { id: deckId }, count: rows.length, cards: rows.map(c => ({ id: c.id, question: c.front, answer: c.back })), error: null });
});
app.post('/card/:id/update', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { question, answer } = req.body;
  const c = db.cards.find(x => x.id === id);
  if (c) { c.front = String(question || '').trim(); c.back = String(answer || '').trim(); }
  await saveDb();
  const deckId = c ? c.flashcard_id : null;
  if (!deckId) return res.redirect('/dashboard');
  const rows = db.cards.filter(x => x.flashcard_id === deckId);
  res.render('add_deck', { step: 'review', deck: { id: deckId }, count: rows.length, cards: rows.map(r => ({ id: r.id, question: r.front, answer: r.back })), error: null });
});
app.post('/card/:id/delete', requireAuth, async (req, res) => {
  const id = req.params.id;
  const c = db.cards.find(x => x.id === id);
  const deckId = c ? c.flashcard_id : null;
  db.cards = db.cards.filter(x => x.id !== id);
  await saveDb();
  if (!deckId) return res.redirect('/dashboard');
  const rows = db.cards.filter(x => x.flashcard_id === deckId);
  res.render('add_deck', { step: 'review', deck: { id: deckId }, count: rows.length, cards: rows.map(r => ({ id: r.id, question: r.front, answer: r.back })), error: null });
});
app.post('/deck/:id/finalize', requireAuth, (req, res) => { res.redirect('/recent'); });

app.get('/recent', requireAuth, (req, res) => {
  const deck = db.flashcards.filter(f => f.user_id === req.session.userId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!deck) return res.render('recent', { deck: null, cards: [] });
  const cards = db.cards.filter(c => c.flashcard_id === deck.id).map(c => ({ id: c.id, question: c.front, answer: c.back }));
  res.render('recent', { deck: { id: deck.id, name: deck.title }, cards });
});
app.get('/deck/:id/study', requireAuth, (req, res) => {
  const id = req.params.id;
  const deck = db.flashcards.find(f => f.id === id && f.user_id === req.session.userId);
  if (!deck) return res.redirect('/dashboard');
  const cards = db.cards.filter(c => c.flashcard_id === id).map(c => ({ id: c.id, question: c.front, answer: c.back }));
  res.render('recent', { deck: { id: deck.id, name: deck.title }, cards });
});
app.get('/deck/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const deck = db.flashcards.find(f => f.id === id && f.user_id === req.session.userId);
  if (!deck) return res.redirect('/dashboard');
  const cards = db.cards.filter(c => c.flashcard_id === id).map(c => ({ id: c.id, question: c.front, answer: c.back }));
  res.render('recent', { deck: { id: deck.id, name: deck.title }, cards });
});
app.get('/deck/:id/test', requireAuth, (req, res) => {
  const id = req.params.id;
  const deck = db.flashcards.find(f => f.id === id && f.user_id === req.session.userId);
  if (!deck) return res.redirect('/dashboard');
  const cards = db.cards.filter(c => c.flashcard_id === id).map(c => ({ id: c.id, question: c.front, answer: c.back }));
  res.render('test', { deck: { id: deck.id, name: deck.title }, cards });
});
app.post('/deck/:id/test/submit', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { answers } = req.body;
  if (Array.isArray(answers)) {
    try {
      let correct = 0;
      const sid = uuidv4();
      for (const a of answers) {
        const card = db.cards.find(c => c.id === a.cardId && c.flashcard_id === id);
        if (!card) continue;
        const expected = (card.back || '').toString().trim().toLowerCase();
        const given = (a.answer || '').toString().trim().toLowerCase();
        const is_correct = (expected.length>0 && expected === given) ? 1 : 0;
        if (is_correct) correct++;
        const aid = uuidv4();
        db.answers.push({ id: aid, score_id: sid, user_id: req.session.userId, flashcard_id: id, card_id: card.id, given: a.answer || '', expected: card.back || '', is_correct, created_at: new Date().toISOString() });
      }
      const total = answers.length;
      db.scores.push({ id: sid, user_id: req.session.userId, flashcard_id: id, score: correct, total, created_at: new Date().toISOString() });
      await saveDb();
      return res.json({ ok: true, score_id: sid, correct, total });
    } catch (e) {
      console.error('submit session answers error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  }
  const { score, total, confirm } = req.body;
  if (confirm !== 'yes') return res.redirect('/dashboard');
  const sid = uuidv4();
  db.scores.push({ id: sid, user_id: req.session.userId, flashcard_id: id, score: parseInt(score || '0', 10), total: parseInt(total || '0', 10), created_at: new Date().toISOString() });
  await saveDb();
  res.redirect('/previous');
});
app.get('/previous', requireAuth, (req, res) => {
  const userDecks = db.flashcards.filter(f => f.user_id === req.session.userId);
  const attendedIds = new Set(db.scores.filter(s => s.user_id === req.session.userId).map(s => s.flashcard_id));
  const notAttended = userDecks.filter(f => !attendedIds.has(f.id)).map(f => ({ id: f.id, name: f.title }));
  const attended = userDecks.filter(f => attendedIds.has(f.id)).map(f => ({ id: f.id, name: f.title }));
  res.render('previous', { notAttended, attended });
});
app.get('/deck/:id/test/result', requireAuth, (req, res) => {
  const id = req.params.id;
  const deck = db.flashcards.find(f => f.id === id && f.user_id === req.session.userId);
  if (!deck) return res.redirect('/dashboard');
  const results = db.scores
    .filter(s => s.flashcard_id === id && s.user_id === req.session.userId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = results[0];
  let rows = [];
  let attended = 0;
  let unattended = 0;
  let right = 0;
  let wrong = 0;
  if (latest) {
    const ans = db.answers.filter(a => a.score_id === latest.id);
    rows = ans.map(a => {
      let question_text = '';
      let given_text = '';
      let expected_text = '';
      let is_right = 0;
      const card = a.card_id ? db.cards.find(c => c.id === a.card_id) : null;
      if (card) {
        question_text = card.front || '';
        given_text = (a.given || '');
        expected_text = (a.expected || '');
        const g = given_text.toString().trim().toLowerCase();
        const e = expected_text.toString().trim().toLowerCase();
        is_right = g.length>0 && e.length>0 && g === e ? 1 : 0;
      } else if (a.question_id) {
        const q = db.questions.find(q => q.id === a.question_id) || {};
        question_text = q.text || '';
        const chosen = db.choices.find(c => c.id === a.choice_id) || {};
        const correctChoice = db.choices.find(c => c.question_id === a.question_id && c.is_correct === 1) || {};
        given_text = chosen.text || '';
        expected_text = correctChoice.text || '';
        is_right = a.is_correct === 1 ? 1 : 0;
      }
      const is_attended = (given_text || '').toString().trim().length > 0 ? 1 : 0;
      if (is_attended) attended++; else unattended++;
      if (is_right) right++; else wrong++;
      return { question: question_text, given: given_text, expected: expected_text, status: is_right ? 'Right' : 'Wrong' };
    });
  }
  res.render('test_result', {
    deck: { id: deck.id, name: deck.title },
    results,
    latest,
    summary: { attended, unattended, right, wrong },
    rows
  });
});
app.get('/recent-view', authMiddleware, (req, res) => {
  const deck = db.flashcards
    .filter(f => f.user_id === req.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!deck) return res.render('recent', { deck: null, cards: [] });
  const cards = db.cards.filter(c => c.flashcard_id === deck.id).map(c => ({ id: c.id, question: c.front, answer: c.back }));
  res.render('recent', { deck: { id: deck.id, name: deck.title }, cards });
});

app.get('/test-view/:id', authMiddleware, (req, res) => {
  const id = req.params.id;
  const deck = db.flashcards.find(f => f.id === id && f.user_id === req.user.id);
  if (!deck) return res.redirect('/recent-view');
  const cards = db.cards.filter(c => c.flashcard_id === id).map(c => ({ id: c.id, question: c.front, answer: c.back }));
  res.render('test', { deck: { id: deck.id, name: deck.title }, cards });
});

app.post('/api/flashcards/:id/questions', authMiddleware, async (req, res) => {
  try {
    const flashcardId = req.params.id;
    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'questions required' });
    for (const q of questions) {
      const qid = uuidv4();
      db.questions.push({ id: qid, flashcard_id: flashcardId, text: q.question });
      for (let i = 0; i < q.choices.length; i++) {
        const choiceId = uuidv4();
        db.choices.push({ id: choiceId, question_id: qid, text: q.choices[i], is_correct: (i === q.answerIndex) ? 1 : 0 });
      }
    }
    await saveDb();
    res.json({ ok: true });
  } catch (e) {
    console.error('add questions error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/flashcards/:id/questions', authMiddleware, (req, res) => {
  const flashcardId = req.params.id;
  const qs = db.questions.filter(q => q.flashcard_id === flashcardId);
  const result = qs.map(q => ({
    id: q.id,
    question: q.text,
    choices: db.choices.filter(c => c.question_id === q.id).map(c => ({ id: c.id, text: c.text }))
  }));
  res.json(result);
});

app.post('/api/flashcards/:id/submit', authMiddleware, async (req, res) => {
  try {
    const flashcardId = req.params.id;
    const { answers } = req.body;
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers required' });
    let correct = 0;
    for (const a of answers) {
      const choice = db.choices.find(c => c.id === a.choiceId && c.question_id === a.questionId);
      if (choice && choice.is_correct === 1) correct++;
    }
    const total = answers.length;
    const id = uuidv4();
    db.scores.push({ id, user_id: req.user.id, flashcard_id: flashcardId, score: correct, total, created_at: new Date().toISOString() });
    for (const a of answers) {
      const aid = uuidv4();
      const choice = db.choices.find(c => c.id === a.choiceId && c.question_id === a.questionId);
      const is_correct = (choice && choice.is_correct === 1) ? 1 : 0;
      db.answers.push({ id: aid, score_id: id, question_id: a.questionId, choice_id: a.choiceId, is_correct });
    }
    let bonus = 0;
    const pct = total ? (correct / total) : 0;
    if (pct >= 0.9) bonus = 10; else if (pct >= 0.8) bonus = 7; else if (pct >= 0.7) bonus = 5;
    if (bonus > 0) {
      req.user.points = (req.user.points || 0) + bonus;
    }
    await saveDb();
    res.json({ correct, total, bonus });
  } catch (e) {
    console.error('submit answers error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/wrong-answers', authMiddleware, (req, res) => {
  const rows = db.answers.filter(a => a.is_correct === 0).map(a => ({ question_id: a.question_id, choice_id: a.choice_id, score_id: a.score_id, id: a.id }));
  const out = rows.map(a => ({ id: a.id, question_text: (db.questions.find(q => q.id === a.question_id) || {}).text, chosen_text: (db.choices.find(c => c.id === a.choice_id) || {}).text }));
  res.json(out);
});

app.get('/api/previous', authMiddleware, (req, res) => {
  const scored = db.scores.filter(s => s.user_id === req.user.id).map(s => s.flashcard_id);
  const unique = Array.from(new Set(scored));
  const rows = unique.map(id => {
    const f = db.flashcards.find(x => x.id === id) || {};
    const last = (db.scores.filter(s => s.flashcard_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || {}).created_at;
    return { id: f.id, title: f.title, description: f.description, last_revised: last };
  });
  res.json(rows);
});

app.get('/api/scores', authMiddleware, (req, res) => {
  const rows = db.scores.filter(s => s.user_id === req.user.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
  res.json(rows);
});

app.get('/api/points', authMiddleware, (req, res) => {
  res.json({ points: req.user.points || 0 });
});

// --- Start server after loading DB ---
function startServer(port) {
  const server = app.listen(port, () => console.log('✅ Server running on port', port));
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const next = port + 1;
      startServer(next);
      return;
    }
    throw err;
  });
}

loadDb().then(() => {
  startServer(PORT);
}).catch(err => {
  console.error('Failed to initialize DB:', err);
  process.exit(1);
});
