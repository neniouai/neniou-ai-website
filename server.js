import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // needed on Render for express-rate-limit to see real client IPs
app.use(express.json({ limit: '20mb' })); // raised limit to allow base64 image/PDF uploads
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const PORT = process.env.PORT || 3000;

if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY in your .env file.');
  process.exit(1);
}

// =====================================================================
// FIREBASE (Firestore) — persistent storage that survives restarts and
// deploys, unlike local JSON files on Render's ephemeral filesystem.
// =====================================================================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ Missing FIREBASE_SERVICE_ACCOUNT in your .env file (paste the full service account JSON as one line).');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT is not valid JSON. Check your .env file.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const conversationsCollection = db.collection('conversations');

async function listConversationsForClient(clientId) {
  // Sorting in JS instead of using .orderBy() avoids needing a Firestore
  // composite index (where + orderBy on different fields requires one).
  const snapshot = await conversationsCollection
    .where('clientId', '==', clientId)
    .get();

  const results = snapshot.docs.map((doc) => {
    const data = doc.data();
    return { id: doc.id, title: data.title, updatedAt: data.updatedAt };
  });

  results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return results;
}

async function createConversationForClient(clientId) {
  const docRef = await conversationsCollection.add({
    clientId,
    title: 'New chat',
    messages: [],
    updatedAt: new Date().toISOString()
  });
  return docRef.id;
}

async function getConversationForClient(clientId, conversationId) {
  const doc = await conversationsCollection.doc(conversationId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (data.clientId !== clientId) return null; // don't leak other people's conversations
  return { id: doc.id, ...data };
}

async function saveConversation(conversationId, updates) {
  await conversationsCollection.doc(conversationId).set(updates, { merge: true });
}

async function deleteConversationForClient(clientId, conversationId) {
  const doc = await conversationsCollection.doc(conversationId).get();
  if (!doc.exists || doc.data().clientId !== clientId) return false;
  await conversationsCollection.doc(conversationId).delete();
  return true;
}

function makeTitle(firstMessage) {
  const clean = firstMessage.trim().replace(/\s+/g, ' ');
  if (!clean) return 'Image';
  return clean.length > 40 ? clean.slice(0, 40) + '…' : clean;
}

async function requireClientId(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.clientId = decoded.uid; // the Firebase Auth UID uniquely and durably identifies this Google account
  } catch (error) {
    console.error('❌ Token verification failed:', error.message || error);
    return res.status(401).json({ error: 'Invalid or expired session, please sign in again.' });
  }

  next();
}

// =====================================================================
// HEALTH CHECK — used by an uptime pinger (e.g. UptimeRobot) to keep the
// free Render instance from spinning down after 15 minutes of inactivity.
// =====================================================================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});

// =====================================================================
// BASIC RATE LIMITING — burst protection on top of the daily fair-use
// quota below. This stops a script from hammering the API in seconds.
// =====================================================================
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes en peu de temps. Attendez une minute.' }
});
app.use('/api/', apiLimiter);

// =====================================================================
// CONVERSATION ROUTES
// =====================================================================
app.get('/api/conversations', requireClientId, async (req, res) => {
  try {
    const summaries = await listConversationsForClient(req.clientId);
    res.json({ conversations: summaries });
  } catch (error) {
    console.error('❌ List conversations error:', error.message || error);
    res.status(500).json({ error: 'Could not load conversations.' });
  }
});

app.post('/api/conversations', requireClientId, async (req, res) => {
  try {
    const id = await createConversationForClient(req.clientId);
    res.json({ id });
  } catch (error) {
    console.error('❌ Create conversation error:', error.message || error);
    res.status(500).json({ error: 'Could not create conversation.' });
  }
});

app.get('/api/conversations/:id', requireClientId, async (req, res) => {
  try {
    const conversation = await getConversationForClient(req.clientId, req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const lightMessages = (conversation.messages || []).map((m) => ({
      role: m.role,
      parts: m.parts.map((p) => (p.inline_data ? { text: '[Image]' } : p))
    }));

    res.json({ messages: lightMessages });
  } catch (error) {
    console.error('❌ Get conversation error:', error.message || error);
    res.status(500).json({ error: 'Could not load conversation.' });
  }
});

app.patch('/api/conversations/:id', requireClientId, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'A non-empty title is required' });
    }

    const conversation = await getConversationForClient(req.clientId, req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    await saveConversation(req.params.id, { title: title.trim().slice(0, 60) });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Rename conversation error:', error.message || error);
    res.status(500).json({ error: 'Could not rename conversation.' });
  }
});

app.delete('/api/conversations/:id', requireClientId, async (req, res) => {
  try {
    await deleteConversationForClient(req.clientId, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Delete conversation error:', error.message || error);
    res.status(500).json({ error: 'Could not delete conversation.' });
  }
});

// Wipes every conversation belonging to this account — called right before
// the Firebase Auth account itself is deleted, so no orphaned data is left.
app.delete('/api/account/data', requireClientId, async (req, res) => {
  try {
    const snapshot = await conversationsCollection.where('clientId', '==', req.clientId).get();
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    res.json({ ok: true, deleted: snapshot.size });
  } catch (error) {
    console.error('❌ Delete account data error:', error.message || error);
    res.status(500).json({ error: 'Could not delete account data.' });
  }
});

// =====================================================================
// GEMINI CHAT LOGIC
// =====================================================================
function buildSystemPrompt() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Port-au-Prince' });

  return `You are "Neniou AI", a virtual assistant created by Hanania.

CURRENT DATE: Today is ${dateStr} (Haiti time). Always use this as the real, correct current date — never guess or rely on your training data for "what year/date is it today", since your training data has a cutoff in the past. If asked the date, time-relative questions ("this year", "how many years since X"), always calculate from the date above.

STRICT RULES:
1. Reply in the SAME LANGUAGE as the person's MOST RECENT message, not the language used earlier in this conversation. Each message can be in a different language than the one before it — always check the latest message specifically and match that one. If they write in Haitian Creole, reply in Haitian Creole. If they write in French, reply in French. If they write in English, reply in English. If they write in another language, reply in that language. Never mix languages in a single reply, and never default to a language just because earlier turns used it.
2. Never mention your name ("Neniou AI") or who created you unless directly asked something like "who are you", "what's your name", or "who made you". If they don't ask, just answer directly without introducing yourself.
3. If asked about your identity, only then say you are Neniou AI, created by Hanania — always in the language the person used. Never say you are Gemini, Google, or any other name.
4. Stay friendly, clear, and direct in your answers. Match the depth of your answer to the question: for simple factual or conversational messages, a short direct answer is right. For questions that ask for an explanation, a list of options, a comparison, or "how" / "why" something works, give a genuinely useful, reasonably detailed answer instead of a one-line reply — don't sacrifice usefulness just to be brief.
5. Remember what was said earlier in this conversation (the history below) and stay consistent with it — don't treat every message as a brand new conversation.
6. Never repeat a previous reply word-for-word. Each answer must directly address what the person just wrote, even if their message is short, informal, or uses slang.
7. You may use light Markdown formatting when it genuinely helps readability: **bold** for key terms, numbered or bulleted lists for steps or multiple items, and fenced code blocks (\`\`\`) for any code or command. Don't overuse formatting for short conversational replies.
8. If the person sends an image or a PDF document, look at it carefully and respond to what they asked about it (summarize, explain, answer questions about it, or describe it helpfully if they didn't ask a specific question).
9. Respect the person's privacy: never ask for personal information (full name, phone number, address, ID numbers, etc.) unless it's clearly necessary to answer their specific question, and never repeat sensitive personal details back unnecessarily. If asked how their data is handled, explain plainly that conversations are stored only to keep context for that person, are not sold or shared with advertisers, and are used only to generate replies.
10. When writing in Haitian Creole, use correct standard orthography, including apostrophes for elided pronouns and markers. Common correct forms: "m ap" or "m'ap", "w ap" or "w'ap", "l ap" or "l'ap", "n ap" or "n'ap", "yo ap", "pa gen", "se yon", "genyen". Do not drop apostrophes where they're grammatically expected, and do not insert them where they don't belong (e.g. "li pa" not "li p'a", "ou vle" not "ou v'le"). Prioritize natural, correctly spelled Kreyòl over literal transcription of casual speech.`;
}

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
      system_instruction: { parts: [{ text: buildSystemPrompt() }] },
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

// Streams text chunks from Gemini as they're generated, using Gemini's
// own Server-Sent Events output (alt=sse). Yields plain text pieces.
async function* streamGeminiChunks(contents, attempt = 1) {
  await waitForTurn();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: buildSystemPrompt() }] },
      contents
    })
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    const isRateLimit = response.status === 429;
    if (isRateLimit && attempt <= 2) {
      const waitMs = 15000 * attempt;
      console.log(`⏳ Rate limit hit (stream), waiting ${waitMs / 1000}s then retrying (${attempt}/2)...`);
      await sleep(waitMs);
      yield* streamGeminiChunks(contents, attempt + 1);
      return;
    }
    throw new Error(`Gemini stream error (${response.status}): ${errText.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep any incomplete trailing line for next chunk

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr) continue;

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        continue;
      }

      const piece = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (piece) yield piece;
    }
  }
}

const ALLOWED_ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const MAX_ATTACHMENT_BASE64_LENGTH = 14_000_000;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';
const PLAIN_TEXT_MIMES = ['text/plain', 'text/csv', 'text/markdown', 'application/json', 'text/html', 'text/xml', 'application/rtf'];
const EXTRACTABLE_DOCUMENT_TYPES = [DOCX_MIME, XLSX_MIME, XLS_MIME, ...PLAIN_TEXT_MIMES];

const MAX_EXTRACTED_TEXT_CHARS = 20000;

async function extractDocumentText(mimeType, base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');

  if (mimeType === DOCX_MIME) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === XLSX_MIME || mimeType === XLS_MIME) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    let combined = '';
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      combined += `--- Feuille: ${sheetName} ---\n${csv}\n\n`;
    }
    return combined;
  }

  if (PLAIN_TEXT_MIMES.includes(mimeType)) {
    return buffer.toString('utf-8');
  }

  throw new Error(`Unsupported document type for extraction: ${mimeType}`);
}

function truncateText(text) {
  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_EXTRACTED_TEXT_CHARS), truncated: true };
}

// =====================================================================
// FAIR-USE DAILY LIMIT (in addition to the burst rate limiter above)
// =====================================================================
const DAILY_MESSAGE_LIMIT = Number(process.env.DAILY_MESSAGE_LIMIT) || 60;
const usageByClient = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function checkAndConsumeQuota(clientId) {
  const key = todayKey();
  const entry = usageByClient.get(clientId);

  if (!entry || entry.dayKey !== key) {
    usageByClient.set(clientId, { count: 1, dayKey: key });
    return { allowed: true };
  }

  if (entry.count >= DAILY_MESSAGE_LIMIT) {
    return { allowed: false };
  }

  entry.count += 1;
  return { allowed: true };
}

// =====================================================================
// CHAT ROUTE
// =====================================================================
// =====================================================================
// GUEST CHAT — lets visitors try Neniou AI without signing in, like
// Gemini/ChatGPT do. Limited to a few messages, kept only in memory
// (not saved to Firestore), and reset if the server restarts.
// =====================================================================
const GUEST_MESSAGE_LIMIT = Number(process.env.GUEST_MESSAGE_LIMIT) || 8;
const guestSessions = new Map(); // guestId -> { messages: [...], count }

app.post('/api/guest-chat/reset', (req, res) => {
  const guestId = req.headers['x-guest-id'];
  if (!guestId) return res.status(400).json({ error: 'Missing guest id' });

  const session = guestSessions.get(guestId);
  if (session) {
    session.messages = []; // fresh context, but session.count (quota used) is untouched
  }
  res.json({ ok: true });
});

app.post('/api/guest-chat', async (req, res) => {
  try {
    const guestId = req.headers['x-guest-id'];
    if (!guestId || typeof guestId !== 'string' || guestId.length > 200) {
      return res.status(400).json({ error: 'Missing guest id' });
    }

    const { message, image, document } = req.body;

    let session = guestSessions.get(guestId);
    if (!session) {
      session = { messages: [], count: 0 };
      guestSessions.set(guestId, session);
    }

    if (session.count >= GUEST_MESSAGE_LIMIT) {
      return res.status(403).json({ error: 'Guest message limit reached. Please sign in to continue.' });
    }

    const hasText = typeof message === 'string' && message.trim().length > 0;
    const hasAttachment = image && typeof image.data === 'string' && typeof image.mimeType === 'string';
    const hasDocument = document && typeof document.data === 'string' && typeof document.mimeType === 'string';

    if (!hasText && !hasAttachment && !hasDocument) {
      return res.status(400).json({ error: 'message or attachment is required' });
    }

    if (hasAttachment && !ALLOWED_ATTACHMENT_TYPES.includes(image.mimeType)) {
      return res.status(400).json({ error: 'Unsupported file type' });
    }
    if (hasDocument && !EXTRACTABLE_DOCUMENT_TYPES.includes(document.mimeType)) {
      return res.status(400).json({ error: 'Unsupported document type' });
    }

    const isPdf = hasAttachment && image.mimeType === 'application/pdf';
    const userMessage = hasText ? message.trim().slice(0, 2000) : '';

    let extractedDocText = '';
    if (hasDocument) {
      try {
        const raw = await extractDocumentText(document.mimeType, document.data);
        extractedDocText = truncateText(raw).text;
      } catch (err) {
        return res.status(400).json({ error: "Impossible de lire ce document." });
      }
    }

    console.log(`👋 [guest ${guestId.slice(0, 8)}] (${userMessage.length} caractères)`);

    const userParts = [];
    if (hasAttachment) {
      userParts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
    }
    if (hasDocument) {
      const userAsk = hasText ? userMessage : 'Résume ce document.';
      userParts.push({ text: `Contenu du document:\n\n${extractedDocText}\n\n${userAsk}` });
    } else {
      const defaultPrompt = isPdf ? 'Résume ce document.' : 'Décris cette image.';
      userParts.push({ text: hasText ? userMessage : defaultPrompt });
    }

    session.messages.push({ role: 'user', parts: userParts });

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.flushHeaders?.();

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    let fullReply = '';
    try {
      for await (const chunk of streamGeminiChunks(session.messages)) {
        if (clientDisconnected) break;
        fullReply += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
    } catch (streamErr) {
      if (!clientDisconnected) {
        console.error('❌ Guest stream error:', streamErr.message || streamErr);
        res.write(`data: ${JSON.stringify({ error: 'Erreur pendant la génération de la réponse.' })}\n\n`);
        res.end();
      }
      return;
    }

    if (clientDisconnected) {
      if (fullReply.trim()) {
        session.messages.push({ role: 'model', parts: [{ text: fullReply.trim() }] });
        session.count += 1;
      }
      return;
    }

    session.messages.push({ role: 'model', parts: [{ text: fullReply.trim() }] });
    session.count += 1;

    res.write(`data: ${JSON.stringify({ done: true, remaining: GUEST_MESSAGE_LIMIT - session.count })}\n\n`);
    res.end();
  } catch (error) {
    console.error('❌ Guest chat error:', error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Something went wrong, please try again.' })}\n\n`);
      res.end();
    }
  }
});

app.post('/api/chat', requireClientId, async (req, res) => {
  try {
    const { conversationId, message, image, document } = req.body;

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
    const hasDocument = document && typeof document.data === 'string' && typeof document.mimeType === 'string';

    if (!hasText && !hasAttachment && !hasDocument) {
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

    if (hasDocument) {
      if (!EXTRACTABLE_DOCUMENT_TYPES.includes(document.mimeType)) {
        return res.status(400).json({ error: 'Unsupported document type' });
      }
      if (document.data.length > MAX_ATTACHMENT_BASE64_LENGTH) {
        return res.status(400).json({ error: 'File is too large' });
      }
    }

    const isPdf = hasAttachment && image.mimeType === 'application/pdf';
    const userMessage = hasText ? message.trim().slice(0, 2000) : '';

    let extractedDocText = '';
    let extractionTruncated = false;
    if (hasDocument) {
      try {
        const raw = await extractDocumentText(document.mimeType, document.data);
        const { text, truncated } = truncateText(raw);
        extractedDocText = text;
        extractionTruncated = truncated;
      } catch (err) {
        console.error('❌ Document extraction error:', err.message || err);
        return res.status(400).json({ error: "Impossible de lire ce document. Le fichier est peut-être corrompu ou dans un format inattendu." });
      }
    }

    const conversation = await getConversationForClient(req.clientId, conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const logTag = hasDocument ? '[document] ' : hasAttachment ? (isPdf ? '[pdf] ' : '[image] ') : '';
    console.log(`📩 [${req.clientId.slice(0, 8)} / ${conversation.title}] ${logTag}(${userMessage.length} caractères)`);

    const userParts = [];
    if (hasAttachment) {
      userParts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
    }

    if (hasDocument) {
      const truncNote = extractionTruncated ? '\n\n[Note: le document est long, seul le début a été inclus.]' : '';
      const docBlock = `Contenu du document "${document.fileName || 'document'}":\n\n${extractedDocText}${truncNote}`;
      const userAsk = hasText ? userMessage : 'Résume ce document et explique-moi son contenu principal.';
      userParts.push({ text: `${docBlock}\n\n${userAsk}` });
    } else {
      const defaultPrompt = isPdf
        ? 'Résume ce document et explique-moi son contenu principal.'
        : 'Décris cette image et dis-moi ce qu\'elle représente.';
      userParts.push({ text: hasText ? userMessage : defaultPrompt });
    }

    const messages = conversation.messages || [];
    messages.push({ role: 'user', parts: userParts });

    // ---- Stream the reply back as Server-Sent Events ----
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.flushHeaders?.();

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    let fullReply = '';
    try {
      for await (const chunk of streamGeminiChunks(messages)) {
        if (clientDisconnected) break; // person pressed "stop" — save what we have and quit early
        fullReply += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
    } catch (streamErr) {
      if (!clientDisconnected) {
        console.error('❌ Stream error:', streamErr.message || streamErr);
        res.write(`data: ${JSON.stringify({ error: 'Erreur pendant la génération de la réponse.' })}\n\n`);
        res.end();
      }
      return;
    }

    if (clientDisconnected) {
      // Still persist whatever partial reply we generated, so it's not lost from history
      if (fullReply.trim()) {
        messages.push({ role: 'model', parts: [{ text: fullReply.trim() }] });
        while (messages.length > MAX_HISTORY_MESSAGES) messages.shift();
        const newTitle = conversation.title === 'New chat' ? makeTitle(userMessage) : conversation.title;
        await saveConversation(conversationId, { messages, title: newTitle, updatedAt: new Date().toISOString() }).catch(() => {});
      }
      return;
    }

    messages.push({ role: 'model', parts: [{ text: fullReply.trim() }] });

    while (messages.length > MAX_HISTORY_MESSAGES) {
      messages.shift();
    }

    const newTitle = conversation.title === 'New chat' ? makeTitle(userMessage) : conversation.title;

    await saveConversation(conversationId, {
      messages,
      title: newTitle,
      updatedAt: new Date().toISOString()
    });

    res.write(`data: ${JSON.stringify({ done: true, title: newTitle })}\n\n`);
    res.end();
    console.log(`✅ Reply streamed`);
  } catch (error) {
    console.error('❌ Error:', error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Something went wrong, please try again.' })}\n\n`);
      res.end();
    }
  }
});

// =====================================================================
// REGENERATE — re-run the model on the existing history after dropping
// the last answer, instead of appending a brand new user turn.
// =====================================================================
// =====================================================================
// EDIT MESSAGE — replaces a previously sent user message, drops
// everything that came after it, and generates a fresh reply.
// =====================================================================
app.post('/api/chat/edit', requireClientId, async (req, res) => {
  try {
    const { conversationId, messageIndex, newText } = req.body;

    if (!conversationId || typeof messageIndex !== 'number' || typeof newText !== 'string' || !newText.trim()) {
      return res.status(400).json({ error: 'conversationId, messageIndex and newText are required' });
    }

    const quota = checkAndConsumeQuota(req.clientId);
    if (!quota.allowed) {
      return res.status(429).json({
        error: `Limite quotidienne atteinte (${DAILY_MESSAGE_LIMIT} messages/jour). Réessayez demain.`
      });
    }

    const conversation = await getConversationForClient(req.clientId, conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = conversation.messages || [];
    if (messageIndex < 0 || messageIndex >= messages.length || messages[messageIndex].role !== 'user') {
      return res.status(400).json({ error: 'Invalid message to edit' });
    }

    // Drop this message and everything after it, then add the edited version.
    const truncated = messages.slice(0, messageIndex);
    truncated.push({ role: 'user', parts: [{ text: newText.trim().slice(0, 2000) }] });

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    let fullReply = '';
    try {
      for await (const chunk of streamGeminiChunks(truncated)) {
        if (clientDisconnected) break;
        fullReply += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
    } catch (streamErr) {
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ error: 'Erreur pendant la génération de la réponse.' })}\n\n`);
        res.end();
      }
      return;
    }

    if (fullReply.trim()) {
      truncated.push({ role: 'model', parts: [{ text: fullReply.trim() }] });
    }

    const newTitle = messageIndex === 0 ? makeTitle(newText.trim()) : conversation.title;
    await saveConversation(conversationId, { messages: truncated, title: newTitle, updatedAt: new Date().toISOString() }).catch(() => {});

    if (clientDisconnected) return;

    res.write(`data: ${JSON.stringify({ done: true, title: newTitle })}\n\n`);
    res.end();
  } catch (error) {
    console.error('❌ Edit message error:', error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    } else {
      res.end();
    }
  }
});

app.post('/api/guest-chat/edit', async (req, res) => {
  try {
    const guestId = req.headers['x-guest-id'];
    if (!guestId || typeof guestId !== 'string' || guestId.length > 200) {
      return res.status(400).json({ error: 'Missing guest id' });
    }

    const { messageIndex, newText } = req.body;
    if (typeof messageIndex !== 'number' || typeof newText !== 'string' || !newText.trim()) {
      return res.status(400).json({ error: 'messageIndex and newText are required' });
    }

    const session = guestSessions.get(guestId);
    if (!session || messageIndex < 0 || messageIndex >= session.messages.length || session.messages[messageIndex].role !== 'user') {
      return res.status(400).json({ error: 'Invalid message to edit' });
    }

    if (session.count >= GUEST_MESSAGE_LIMIT) {
      return res.status(403).json({ error: 'Guest message limit reached. Please sign in to continue.' });
    }

    session.messages = session.messages.slice(0, messageIndex);
    session.messages.push({ role: 'user', parts: [{ text: newText.trim().slice(0, 2000) }] });

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    let fullReply = '';
    try {
      for await (const chunk of streamGeminiChunks(session.messages)) {
        if (clientDisconnected) break;
        fullReply += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
    } catch (streamErr) {
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ error: 'Erreur pendant la génération de la réponse.' })}\n\n`);
        res.end();
      }
      return;
    }

    if (fullReply.trim()) {
      session.messages.push({ role: 'model', parts: [{ text: fullReply.trim() }] });
      session.count += 1;
    }

    if (clientDisconnected) return;

    res.write(`data: ${JSON.stringify({ done: true, remaining: GUEST_MESSAGE_LIMIT - session.count })}\n\n`);
    res.end();
  } catch (error) {
    console.error('❌ Guest edit error:', error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    } else {
      res.end();
    }
  }
});

app.post('/api/chat/regenerate', requireClientId, async (req, res) => {
  try {
    const { conversationId } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    const quota = checkAndConsumeQuota(req.clientId);
    if (!quota.allowed) {
      return res.status(429).json({
        error: `Limite quotidienne atteinte (${DAILY_MESSAGE_LIMIT} messages/jour). Réessayez demain.`
      });
    }

    const conversation = await getConversationForClient(req.clientId, conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = conversation.messages || [];
    if (messages.length === 0 || messages[messages.length - 1].role !== 'model') {
      return res.status(400).json({ error: 'Nothing to regenerate' });
    }
    messages.pop(); // drop the previous answer; the last entry is now the user's message again

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    let fullReply = '';
    try {
      for await (const chunk of streamGeminiChunks(messages)) {
        if (clientDisconnected) break;
        fullReply += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
    } catch (streamErr) {
      if (!clientDisconnected) {
        console.error('❌ Regenerate stream error:', streamErr.message || streamErr);
        res.write(`data: ${JSON.stringify({ error: 'Erreur pendant la génération de la réponse.' })}\n\n`);
        res.end();
      }
      return;
    }

    if (fullReply.trim()) {
      messages.push({ role: 'model', parts: [{ text: fullReply.trim() }] });
      await saveConversation(conversationId, { messages, title: conversation.title, updatedAt: new Date().toISOString() }).catch(() => {});
    }

    if (clientDisconnected) return;

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error('❌ Regenerate error:', error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    } else {
      res.end();
    }
  }
});

app.post('/api/guest-chat/regenerate', async (req, res) => {
  try {
    const guestId = req.headers['x-guest-id'];
    if (!guestId || typeof guestId !== 'string' || guestId.length > 200) {
      return res.status(400).json({ error: 'Missing guest id' });
    }

    const session = guestSessions.get(guestId);
    if (!session || session.messages.length === 0 || session.messages[session.messages.length - 1].role !== 'model') {
      return res.status(400).json({ error: 'Nothing to regenerate' });
    }

    if (session.count >= GUEST_MESSAGE_LIMIT) {
      return res.status(403).json({ error: 'Guest message limit reached. Please sign in to continue.' });
    }

    session.messages.pop();

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    let fullReply = '';
    try {
      for await (const chunk of streamGeminiChunks(session.messages)) {
        if (clientDisconnected) break;
        fullReply += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
    } catch (streamErr) {
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ error: 'Erreur pendant la génération de la réponse.' })}\n\n`);
        res.end();
      }
      return;
    }

    if (fullReply.trim()) {
      session.messages.push({ role: 'model', parts: [{ text: fullReply.trim() }] });
      session.count += 1;
    }

    if (clientDisconnected) return;

    res.write(`data: ${JSON.stringify({ done: true, remaining: GUEST_MESSAGE_LIMIT - session.count })}\n\n`);
    res.end();
  } catch (error) {
    console.error('❌ Guest regenerate error:', error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log('----------------------------------------------------');
  console.log(`🚀 Neniou AI website listening on port ${PORT}`);
  console.log(`   Open: http://localhost:${PORT}`);
  console.log('----------------------------------------------------');
});