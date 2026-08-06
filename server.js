import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '20mb' })); // raised limit to allow base64 image/PDF uploads
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.5-flash-lite'; // this model understands images natively, no extra cost tier
const PORT = process.env.PORT || 3000;

if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY in your .env file.');
  process.exit(1);
}

// =====================================================================
// SIMPLE FILE-BASED DATABASE — no accounts, conversations keyed by an
// anonymous client ID generated and stored in the visitor's browser.
// =====================================================================
const DATA_DIR = path.join(__dirname, 'data');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONVERSATIONS_FILE)) fs.writeFileSync(CONVERSATIONS_FILE, '{}');

function loadAllConversations() {
  return JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf-8'));
}
function saveAllConversations(data) {
  fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2));
}

function makeTitle(firstMessage) {
  const clean = firstMessage.trim().replace(/\s+/g, ' ');
  if (!clean) return 'Image';
  return clean.length > 40 ? clean.slice(0, 40) + '…' : clean;
}

function requireClientId(req, res, next) {
  const clientId = req.headers['x-client-id'];
  if (!clientId || typeof clientId !== 'string' || clientId.length > 200) {
    return res.status(400).json({ error: 'Missing client id' });
  }
  req.clientId = clientId;
  next();
}

// =====================================================================
// CONVERSATION ROUTES
// =====================================================================
app.get('/api/conversations', requireClientId, (req, res) => {
  const allConversations = loadAllConversations();
  const userConversations = allConversations[req.clientId] || [];
  const summaries = userConversations
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ conversations: summaries });
});

app.post('/api/conversations', requireClientId, (req, res) => {
  const allConversations = loadAllConversations();
  const userConversations = allConversations[req.clientId] || [];

  const newConversation = {
    id: crypto.randomUUID(),
    title: 'New chat',
    messages: [],
    updatedAt: new Date().toISOString()
  };

  userConversations.push(newConversation);
  allConversations[req.clientId] = userConversations;
  saveAllConversations(allConversations);

  res.json({ id: newConversation.id });
});

app.get('/api/conversations/:id', requireClientId, (req, res) => {
  const allConversations = loadAllConversations();
  const userConversations = allConversations[req.clientId] || [];
  const conversation = userConversations.find((c) => c.id === req.params.id);

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  // Strip raw image bytes from history responses to keep payloads light —
  // the frontend only needs a placeholder to display for past image messages.
  const lightMessages = conversation.messages.map((m) => ({
    role: m.role,
    parts: m.parts.map((p) =>
      p.inline_data ? { text: '[Image]' } : p
    )
  }));

  res.json({ messages: lightMessages });
});

app.delete('/api/conversations/:id', requireClientId, (req, res) => {
  const allConversations = loadAllConversations();
  const userConversations = allConversations[req.clientId] || [];
  allConversations[req.clientId] = userConversations.filter((c) => c.id !== req.params.id);
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
7. Never use markdown formatting (no **bold**, no *italics*, no # headers, no markdown bullet lists with - or *). Write in plain text only. For lists, use plain numbered lines like "1. Item" or simple line breaks — never asterisks or pound signs.
8. If the person sends an image or a PDF document, look at it carefully and respond to what they asked about it (summarize, explain, answer questions about it, or describe it helpfully if they didn't ask a specific question).`;

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

const ALLOWED_ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const MAX_ATTACHMENT_BASE64_LENGTH = 14_000_000; // ~10MB raw, enough for most PDFs and phone photos

// =====================================================================
// FAIR-USE LIMIT — the Gemini API key is shared across every visitor.
// This caps each anonymous visitor to a reasonable number of messages
// per day so one person can't exhaust the quota for everyone else.
// =====================================================================
const DAILY_MESSAGE_LIMIT = Number(process.env.DAILY_MESSAGE_LIMIT) || 40;
const usageByClient = new Map(); // clientId -> { count, dayKey }

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-08-06"
}

function checkAndConsumeQuota(clientId) {
  const key = todayKey();
  const entry = usageByClient.get(clientId);

  if (!entry || entry.dayKey !== key) {
    usageByClient.set(clientId, { count: 1, dayKey: key });
    return { allowed: true, remaining: DAILY_MESSAGE_LIMIT - 1 };
  }

  if (entry.count >= DAILY_MESSAGE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  entry.count += 1;
  return { allowed: true, remaining: DAILY_MESSAGE_LIMIT - entry.count };
}

// =====================================================================
// CHAT ROUTE — supports text, and optionally an attached image
// =====================================================================
app.post('/api/chat', requireClientId, async (req, res) => {
  try {
    const { conversationId, message, image } = req.body; // 'image' now carries any attachment: image or PDF

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    const quota = checkAndConsumeQuota(req.clientId);
    if (!quota.allowed) {
      return res.status(429).json({
        error: `Limite quotidienne atteinte (${DAILY_MESSAGE_LIMIT} messages/jour). Réessayez demain.`
      });
    }

    const hasText = typeof message === 'string' && message.trim().length > 0;
    const hasAttachment = image && typeof image.data === 'string' && typeof image.mimeType === 'string';

    if (!hasText && !hasAttachment) {
      return res.status(400).json({ error: 'message or attachment is required' });
    }

    if (hasAttachment) {
      if (!ALLOWED_ATTACHMENT_TYPES.includes(image.mimeType)) {
        return res.status(400).json({ error: 'Unsupported file type' });
      }
      if (image.data.length > MAX_ATTACHMENT_BASE64_LENGTH) {
        return res.status(400).json({ error: 'File is too large' });
      }
    }

    const isPdf = hasAttachment && image.mimeType === 'application/pdf';
    const userMessage = hasText ? message.trim().slice(0, 2000) : '';

    const allConversations = loadAllConversations();
    const userConversations = allConversations[req.clientId] || [];
    const conversation = userConversations.find((c) => c.id === conversationId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    console.log(`📩 [${req.clientId.slice(0, 8)} / ${conversation.title}] ${hasAttachment ? (isPdf ? '[pdf] ' : '[image] ') : ''}${userMessage}`);

    const userParts = [];
    if (hasAttachment) {
      userParts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
    }
    const defaultPrompt = isPdf
      ? 'Résume ce document et explique-moi son contenu principal.'
      : 'Décris cette image et dis-moi ce qu\'elle représente.';
    userParts.push({ text: hasText ? userMessage : defaultPrompt });

    conversation.messages.push({ role: 'user', parts: userParts });

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
    console.log(`✅ Reply sent`);
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