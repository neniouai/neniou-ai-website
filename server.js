import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const PORT = process.env.PORT || 3000;

if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY in your .env file.');
  process.exit(1);
}

// =====================================================================
// SIMPLE FILE-BASED DATABASE (JSON files)
// =====================================================================
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
// conversations.json shape: { [userId]: [ { id, title, messages: [{role, parts}], updatedAt } ] }
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(CONVERSATIONS_FILE)) fs.writeFileSync(CONVERSATIONS_FILE, '{}');

function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function loadAllConversations() {
  return JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf-8'));
}
function saveAllConversations(data) {
  fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2));
}

function makeTitle(firstMessage) {
  const clean = firstMessage.trim().replace(/\s+/g, ' ');
  return clean.length > 40 ? clean.slice(0, 40) + '…' : clean;
}

// In-memory active sessions: token -> { userId, username }
const activeSessions = new Map();

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const session = token ? activeSessions.get(token) : null;

  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  req.userId = session.userId;
  req.username = session.username;
  next();
}

function getViewerId(req) {
  return req.userId || 'guest';
}

function getViewerName(req) {
  return req.username || 'guest';
}

// =====================================================================
// AUTH ROUTES
// =====================================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password || username.trim().length < 3 || password.length < 6) {
      return res.status(400).json({ error: "Le nom d'utilisateur doit avoir 3+ caractères et le mot de passe 6+ caractères." });
    }

    const cleanUsername = username.trim().toLowerCase();
    const users = loadUsers();

    if (users.some((u) => u.username === cleanUsername)) {
      return res.status(409).json({ error: "Ce nom d'utilisateur est déjà pris." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = { id: crypto.randomUUID(), username: cleanUsername, passwordHash };
    users.push(newUser);
    saveUsers(users);

    const allConversations = loadAllConversations();
    allConversations[newUser.id] = [];
    saveAllConversations(allConversations);

    const token = createToken();
    activeSessions.set(token, { userId: newUser.id, username: cleanUsername });

    res.json({ token, username: cleanUsername });
    console.log(`✅ New account created: ${cleanUsername}`);
  } catch (error) {
    console.error('❌ Register error:', error.message || error);
    res.status(500).json({ error: 'Une erreur est survenue, veuillez réessayer.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Le nom d'utilisateur et le mot de passe sont requis." });
    }

    const cleanUsername = username.trim().toLowerCase();
    const users = loadUsers();
    const user = users.find((u) => u.username === cleanUsername);

    if (!user) {
      return res.status(401).json({ error: "Nom d'utilisateur ou mot de passe incorrect." });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Nom d'utilisateur ou mot de passe incorrect." });
    }

    const token = createToken();
    activeSessions.set(token, { userId: user.id, username: user.username });

    res.json({ token, username: user.username });
    console.log(`✅ Login: ${user.username}`);
  } catch (error) {
    console.error('❌ Login error:', error.message || error);
    res.status(500).json({ error: 'Une erreur est survenue, veuillez réessayer.' });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.slice(7);
  activeSessions.delete(token);
  res.json({ ok: true });
});

// =====================================================================
// CONVERSATION ROUTES — each conversation has its own isolated history
// =====================================================================

// List all conversations for the logged-in user (id, title, updatedAt only — no messages, keeps payload small)
app.get('/api/conversations', (req, res) => {
  const userId = getViewerId(req);
  const allConversations = loadAllConversations();
  const userConversations = allConversations[userId] || [];
  const summaries = userConversations
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ conversations: summaries });
});

// Create a brand new, empty conversation
app.post('/api/conversations', (req, res) => {
  const userId = getViewerId(req);
  const allConversations = loadAllConversations();
  const userConversations = allConversations[userId] || [];

  const newConversation = {
    id: crypto.randomUUID(),
    title: 'New chat',
    messages: [],
    updatedAt: new Date().toISOString()
  };

  userConversations.push(newConversation);
  allConversations[req.userId] = userConversations;
  saveAllConversations(allConversations);

  res.json({ id: newConversation.id });
});

// Get the full messages of one conversation
app.get('/api/conversations/:id', (req, res) => {
  const userId = getViewerId(req);
  const allConversations = loadAllConversations();
  const userConversations = allConversations[userId] || [];
  const conversation = userConversations.find((c) => c.id === req.params.id);

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  res.json({ messages: conversation.messages });
});

// Delete a conversation
app.delete('/api/conversations/:id', (req, res) => {
  const userId = getViewerId(req);
  const allConversations = loadAllConversations();
  const userConversations = allConversations[userId] || [];
  allConversations[userId] = userConversations.filter((c) => c.id !== req.params.id);
  saveAllConversations(allConversations);
  res.json({ ok: true });
});

// =====================================================================
// GEMINI CHAT LOGIC
// =====================================================================
const SYSTEM_PROMPT = `You are "Neniou AI", a virtual assistant created by Hanania.

STRICT RULES:
1. Reply in the SAME LANGUAGE as the person's MOST RECENT message, not the language used earlier in this conversation. Each message can be in a different language than the one before it — always check the latest message specifically and match that one. If they write in Haitian Creole, reply in Haitian Creole. If they write in French, reply in French. If they write in English, reply in English. If they write in another language, reply in that language. Never mix languages in a single reply, and never default to a language just because earlier turns used it.
2. Never mention your name ("Neniou AI") or who created you unless directly asked something like "who are you", "what's your name", or "who made you". If they don't ask, just answer directly without introducing yourself.
3. If asked about your identity, only then say you are Neniou AI, created by Hanania — always in the language the person used. Never say you are Gemini, Google, or any other name.
4. Stay friendly, clear, and direct in your answers.
5. Remember what was said earlier in this conversation (the history below) and stay consistent with it — don't treat every message as a brand new conversation.
6. Never repeat a previous reply word-for-word. Each answer must directly address what the person just wrote, even if their message is short, informal, or uses slang.
7. Never use markdown formatting (no **bold**, no *italics*, no # headers, no markdown bullet lists with - or *). Write in plain text only. For lists, use plain numbered lines like "1. Item" or simple line breaks — never asterisks or pound signs.`;

const MAX_HISTORY_MESSAGES = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MIN_REQUEST_SPACING_MS = 3500;
let lastRequestAt = 0;

async function waitForTurn() {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_REQUEST_SPACING_MS) {
    await sleep(MIN_REQUEST_SPACING_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

async function askGemini(contents, attempt = 1) {
  await waitForTurn();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents
    })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Gemini did not return JSON: ${text.slice(0, 200)}`);
  }

  if (data.error) {
    const isRateLimit = response.status === 429 || data.error.code === 429;
    if (isRateLimit && attempt <= 3) {
      const waitMs = 15000 * attempt;
      console.log(`⏳ Rate limit hit, waiting ${waitMs / 1000}s then retrying (${attempt}/3)...`);
      await sleep(waitMs);
      return askGemini(contents, attempt + 1);
    }
    throw new Error(data.error.message || 'Unknown Gemini API error');
  }

  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) {
    throw new Error(`No valid reply in response: ${JSON.stringify(data)}`);
  }

  return reply.trim();
}

// =====================================================================
// CHAT ROUTE — now scoped to a single conversationId
// =====================================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    const userId = getViewerId(req);

    if (!conversationId || !message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'conversationId and message are required' });
    }

    const userMessage = message.trim().slice(0, 2000);

    const allConversations = loadAllConversations();
    const userConversations = allConversations[req.userId] || [];
    const conversation = userConversations.find((c) => c.id === conversationId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    console.log(`📩 [${req.username} / ${conversation.title}] ${userMessage}`);

    conversation.messages.push({ role: 'user', parts: [{ text: userMessage }] });

    const reply = await askGemini(conversation.messages);

    conversation.messages.push({ role: 'model', parts: [{ text: reply }] });

    while (conversation.messages.length > MAX_HISTORY_MESSAGES) {
      conversation.messages.shift();
    }

    if (conversation.title === 'New chat') {
      conversation.title = makeTitle(userMessage);
    }
    conversation.updatedAt = new Date().toISOString();

    saveAllConversations(allConversations);

    res.json({ reply, title: conversation.title });
    console.log(`✅ Reply sent to ${req.username}`);
  } catch (error) {
    console.error('❌ Error:', error.message || error);
    res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
});

app.listen(PORT, () => {
  console.log('----------------------------------------------------');
  console.log(`🚀 Neniou AI website listening on port ${PORT}`);
  console.log(`   Open: http://localhost:${PORT}`);
  console.log('----------------------------------------------------');
});