const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const gmailClientId = defineSecret('GMAIL_CLIENT_ID');
const gmailClientSecret = defineSecret('GMAIL_CLIENT_SECRET');
const gmailRedirectUri = defineSecret('GMAIL_REDIRECT_URI');

const ALLOWED_ORIGIN = 'https://robeiov22-coder.github.io';
const CRM_URL = `${ALLOWED_ORIGIN}/med-expert-crm/`;
const ALLOWED_SENDER = 'mail@nikolab.com.ua';
const MAILBOXES = {
  lubetska: 'polyclinic.chernigiv.l@gmail.com',
  tekstylnykiv: 'polyclinic.chernigiv@gmail.com',
  snovsk: 'polyclinic.snovsk@gmail.com'
};

function setCors(res) {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.set('Vary', 'Origin');
}

function oauthClient() {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(
    gmailClientId.value(),
    gmailClientSecret.value(),
    gmailRedirectUri.value()
  );
}

function mailboxByValue(value) {
  return Object.entries(MAILBOXES).find(([, email]) => email === value || email === value?.toLowerCase());
}

function extractPdfParts(payload, result = []) {
  if (!payload) return result;
  if (payload.filename && payload.filename.toLowerCase().endsWith('.pdf')) result.push(payload);
  (payload.parts || []).forEach((part) => extractPdfParts(part, result));
  return result;
}

function decodeBase64Url(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function parsePatientData(filename, text) {
  const cleanName = filename.replace(/\.pdf$/i, '').split(' - ')[0].trim();
  const birthMatch = text.match(/\b(19|20)\d{2}[-./]\d{2}[-./]\d{2}\b/);
  return {
    patientName: cleanName || 'Потребує уточнення',
    birthDate: birthMatch ? birthMatch[0].replace(/\./g, '-') : ''
  };
}

exports.gmailOAuthStart = onRequest({ secrets: [gmailClientId, gmailClientSecret, gmailRedirectUri] }, async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const mailbox = mailboxByValue(req.query.mailbox);
  if (!mailbox) return res.status(400).send('Невідома робоча скринька.');

  const state = crypto.randomBytes(24).toString('hex');
  await db.collection('gmail_oauth_states').doc(state).set({
    mailboxKey: mailbox[0],
    mailbox: mailbox[1],
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    state
  });
  return res.redirect(url);
});

exports.gmailOAuthCallback = onRequest({ secrets: [gmailClientId, gmailClientSecret, gmailRedirectUri] }, async (req, res) => {
  setCors(res);
  try {
    const stateRef = db.collection('gmail_oauth_states').doc(String(req.query.state || ''));
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists) return res.status(400).send('OAuth-сеанс не знайдено або він уже завершився.');
    const state = stateSnap.data();
    await stateRef.delete();

    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code || ''));
    await db.collection('gmail_connections').doc(state.mailboxKey).set({
      mailboxKey: state.mailboxKey,
      mailbox: state.mailbox,
      tokens,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      enabled: true
    }, { merge: true });

    return res.redirect(`${CRM_URL}?gmail=connected&mailbox=${encodeURIComponent(state.mailbox)}`);
  } catch (error) {
    console.error('gmailOAuthCallback failed', error);
    return res.status(500).send('Не вдалося підключити Gmail. Перевірте OAuth-дозвіл.');
  }
});

exports.gmailSync = onRequest({ secrets: [gmailClientId, gmailClientSecret, gmailRedirectUri], timeoutSeconds: 300, memory: '1GiB' }, async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Потрібен POST-запит.' });

  const mailbox = mailboxByValue(req.body?.mailbox || req.query.mailbox);
  if (!mailbox) return res.status(400).json({ error: 'Невідома робоча скринька.' });
  const connectionSnap = await db.collection('gmail_connections').doc(mailbox[0]).get();
  if (!connectionSnap.exists) return res.status(409).json({ error: 'Спочатку авторизуйте цю робочу скриньку.' });

  const client = oauthClient();
  const { google } = require('googleapis');
  const pdfParse = require('pdf-parse');
  client.setCredentials(connectionSnap.data().tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const bucket = admin.storage().bucket();
  const listed = await gmail.users.messages.list({
    userId: 'me',
    q: `from:${ALLOWED_SENDER} has:attachment newer_than:30d`,
    maxResults: 100
  });

  let imported = 0;
  for (const item of listed.data.messages || []) {
    const existing = await db.collection('gmail_imports').doc(item.id).get();
    if (existing.exists) continue;
    const message = await gmail.users.messages.get({ userId: 'me', id: item.id, format: 'full' });
    const pdfParts = extractPdfParts(message.data.payload);
    for (const part of pdfParts) {
      let fileBuffer;
      if (part.body?.attachmentId) {
        const attachment = await gmail.users.messages.attachments.get({ userId: 'me', messageId: item.id, id: part.body.attachmentId });
        fileBuffer = decodeBase64Url(attachment.data.data);
      } else if (part.body?.data) {
        fileBuffer = decodeBase64Url(part.body.data);
      } else {
        continue;
      }
      const parsed = await pdfParse(fileBuffer);
      const patient = parsePatientData(part.filename, parsed.text || '');
      const storagePath = `lab-results/${mailbox[0]}/${item.id}/${part.filename}`;
      await bucket.file(storagePath).save(fileBuffer, { metadata: { contentType: 'application/pdf' } });
      await db.collection('gmail_imports').doc(item.id).set({
        messageId: item.id,
        mailboxKey: mailbox[0],
        mailbox: mailbox[1],
        provider: 'Ніколаб',
        sender: ALLOWED_SENDER,
        attachmentName: part.filename,
        storagePath,
        patientName: patient.patientName,
        birthDate: patient.birthDate,
        rawText: (parsed.text || '').slice(0, 50000),
        status: 'Потребує перевірки',
        aiComment: '',
        receivedAt: admin.firestore.Timestamp.fromMillis(Number(message.data.internalDate || Date.now())),
        importedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      imported += 1;
    }
  }

  await db.collection('gmail_connections').doc(mailbox[0]).set({ lastSyncAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return res.json({ ok: true, mailbox: mailbox[1], imported });
});

