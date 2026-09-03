require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WALCHEM_ROOT_FOLDER_ID = process.env.WALCHEM_ROOT_FOLDER_ID || '';
const MAX_DOCS_PER_QUERY = parseInt(process.env.MAX_DOCS_PER_QUERY || '2', 10);
const MAX_PDF_BYTES = 32 * 1024 * 1024;

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

async function downloadPdfBuffer(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
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

    const documentBlocks = [];
    const sources = [];

    for (const file of candidates) {
      try {
        const sizeBytes = file.size ? parseInt(file.size, 10) : 0;
        if (sizeBytes && sizeBytes > MAX_PDF_BYTES) {
          console.warn(`Se omite ${file.name}: pesa ${(sizeBytes / 1e6).toFixed(1)}MB, supera el limite de 32MB por documento`);
          continue;
        }
        const buffer = await downloadPdfBuffer(drive, file.id);
        documentBlocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: buffer.toString('base64')
          },
          citations: { enabled: true }
        });
        sources.push({
          title: file.name,
          url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`
        });
      } catch (e) {
        console.error('Error leyendo archivo', file.name, e.message);
      }
    }

    const systemPrompt = `Sos el asistente tecnico interno de Filsa, para el equipo que da soporte a equipos Walchem (bombas dosificadoras, controladores, sensores y accesorios de tratamiento de agua).

Tenes dos fuentes de informacion disponibles:
1. Los documentos PDF originales adjuntos a este mensaje (si hay alguno) - son los manuales reales de Walchem, con su texto, tablas, diagramas y esquemas completos. Esta es tu fuente PRINCIPAL y mas confiable para specs, procedimientos y troubleshooting.
2. Busqueda web, disponible como herramienta - usala solo cuando necesites complementar con informacion que genuinamente no este en los documentos adjuntos (ej. una actualizacion reciente de Walchem/Iwaki, un dato de contexto general de ingenieria, o confirmar algo cuando no se adjunto ningun documento relevante).

Reglas:
- Si citas informacion de un PDF adjunto, respondé con precision tecnica de ese documento.
- Si complementas con busqueda web, aclaralo explicitamente en la respuesta (ej. "Según el sitio de Walchem...").
- Si no hay documentos adjuntos relevantes y la busqueda web tampoco encuentra nada solido, decilo con honestidad en vez de inventar valores tecnicos, rangos o procedimientos de seguridad.

Se conciso, directo y accionable, como si hablaras con un tecnico que necesita resolver algo ahora. Usa listas numeradas para procedimientos paso a paso. Respondé siempre en español.${documentBlocks.length === 0 ? '\n\n(No se encontraron documentos relevantes en Drive para esta consulta - respondé con lo que sepas y/o usando búsqueda web, dejando claro que no viene de un manual específico.)' : ''}`;

    const userContent = [
      ...documentBlocks,
      { type: 'text', text: message }
    ];

    const apiMessages = [...history, { role: 'user', content: userContent }];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
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
