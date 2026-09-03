require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WALCHEM_ROOT_FOLDER_ID = process.env.WALCHEM_ROOT_FOLDER_ID || '';
const MAX_CHARS_PER_DOC = parseInt(process.env.MAX_CHARS_PER_DOC || '150000', 10);
const MAX_DOCS_PER_QUERY = parseInt(process.env.MAX_DOCS_PER_QUERY || '3', 10);

const STOPWORDS = new Set([
  'de','la','el','en','y','a','los','las','un','una','que','con','para','por','se','es','del','al',
  'como','su','sus','o','este','esta','estos','estas','manual','sensor','sensores','bomba','bombas',
  'walchem','instrucciones','cual','cuales','donde','cuando','porque','pero','mas','muy','desde','hasta',
  'the','and','for','with','how','what','pump','manual','sensor'
]);

function extractKeywords(text) {
  const words = (text.toLowerCase().match(/[a-záéíóúñ0-9-]+/g) || [])
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); out.push(w); }
    if (out.length >= 8) break;
  }
  return out;
}

function escapeForDriveQuery(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getDriveClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Falta GOOGLE_SERVICE_ACCOUNT_JSON en las variables de entorno');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  return google.drive({ version: 'v3', auth });
}

async function searchDrivePdfs(drive, keywords) {
  if (keywords.length === 0) return [];
  const resultsMap = new Map();
  const topKeywords = keywords.slice(0, 5);

  for (const kwRaw of topKeywords) {
    const kw = escapeForDriveQuery(kwRaw);
    const queries = [
      `mimeType = 'application/pdf' and trashed = false and name contains '${kw}'`,
      `mimeType = 'application/pdf' and trashed = false and fullText contains '${kw}'`
    ];
    for (const q of queries) {
      try {
        const res = await drive.files.list({
          q,
          pageSize: 8,
          fields: 'files(id,name,webViewLink,size)'
        });
        for (const f of (res.data.files || [])) {
          if (!resultsMap.has(f.id)) resultsMap.set(f.id, f);
        }
      } catch (e) {
        console.error(`Error buscando "${kwRaw}":`, e.message);
      }
    }
  }
  return Array.from(resultsMap.values());
}

async function downloadPdfText(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  const buffer = Buffer.from(res.data);
  const parsed = await pdfParse(buffer);
  return parsed.text;
}

function rankFiles(files, keywords) {
  return files
    .map(f => {
      const titleLower = f.name.toLowerCase();
      let score = 0;
      for (const k of keywords) {
        if (titleLower.includes(k)) score += 2;
      }
      if (titleLower.includes('manual')) score += 1;
      return { file: f, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(x => x.file);
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Falta el campo "message"' });
    }

    const drive = getDriveClient();
    const keywords = extractKeywords(message);

    let candidates = [];
    try {
      candidates = await searchDrivePdfs(drive, keywords);
    } catch (e) {
      console.error('Error buscando en Drive:', e.message);
    }

    const seenNames = new Set();
    candidates = candidates.filter(f => {
      if (seenNames.has(f.name)) return false;
      seenNames.add(f.name);
      return true;
    });
    candidates = rankFiles(candidates, keywords).slice(0, MAX_DOCS_PER_QUERY);

    const contextBlocks = [];
    const sources = [];

    for (const file of candidates) {
      try {
        const text = await downloadPdfText(drive, file.id);
        const truncated = text.length > MAX_CHARS_PER_DOC;
        contextBlocks.push(
          `### ${file.name}${truncated ? ' (truncado por longitud)' : ''}\n${text.slice(0, MAX_CHARS_PER_DOC)}`
        );
        sources.push({
          title: file.name,
          url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`
        });
      } catch (e) {
        console.error('Error leyendo archivo', file.name, e.message);
      }
    }

    const systemPrompt = `Sos el asistente tecnico interno de Filsa, para el equipo que da soporte a equipos Walchem (bombas dosificadoras, controladores, sensores y accesorios de tratamiento de agua).

Respondé la consulta del técnico usando la información de los documentos completos que te paso a continuación (es el texto íntegro extraído en el momento desde los PDF originales en Google Drive, sin resumir ni modificar). Si el contexto no alcanza para responder con precisión, decilo con honestidad en vez de inventar valores técnicos, rangos o procedimientos de seguridad.

Sé conciso, directo y accionable, como si hablaras con un técnico que necesita resolver algo ahora. Usá listas numeradas para procedimientos paso a paso. Respondé en español.

${contextBlocks.length ? 'DOCUMENTOS COMPLETOS ENCONTRADOS:\n\n' + contextBlocks.join('\n\n---\n\n') : '(No se encontraron documentos relevantes en Drive para esta consulta.)'}`;

    const apiMessages = [...history, { role: 'user', content: message }];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: apiMessages
    });

    const replyText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n\n');

    res.json({ reply: replyText, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Walchem Tech Assistant escuchando en puerto ${PORT}`);
});
