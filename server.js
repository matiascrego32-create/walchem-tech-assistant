require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas } = require('canvas');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemma-4-26b-a4b-it';

const WALCHEM_ROOT_FOLDER_ID = process.env.WALCHEM_ROOT_FOLDER_ID || '';
const MAX_DOCS_PER_QUERY = parseInt(process.env.MAX_DOCS_PER_QUERY || '1', 10);
const MAX_PAGES_PER_DOC = parseInt(process.env.MAX_PAGES_PER_DOC || '12', 10);
const MAX_PDF_BYTES = 30 * 1024 * 1024;

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

async function pdfBufferToPageImages(buffer, maxPages) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const numPages = Math.min(pdf.numPages, maxPages);
  const images = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    images.push(canvas.toBuffer('image/png').toString('base64'));
  }
  return { images, totalPages: pdf.numPages, pagesUsed: numPages };
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

function historyToGeminiContents(history) {
  return history.map(turn => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }]
  }));
}

async function searchWeb(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 3,
        search_depth: 'basic'
      })
    });
    if (!res.ok) {
      console.error('Tavily respondio con error HTTP', res.status);
      return null;
    }
    const data = await res.json();
    return data.results || [];
  } catch (e) {
    console.error('Error en busqueda web:', e.message);
    return null;
  }
}

async function generateWithRetry(params, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (e) {
      lastError = e;
      const isOverloaded = e.message && (e.message.includes('"code":503') || e.message.includes('UNAVAILABLE'));
      if (isOverloaded && attempt < maxRetries - 1) {
        const waitMs = 1500 * (attempt + 1);
        console.warn(`Modelo saturado (503), reintentando en ${waitMs}ms (intento ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
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

    const documentParts = [];
    const sources = [];

    for (const file of candidates) {
      try {
        const sizeBytes = file.size ? parseInt(file.size, 10) : 0;
        if (sizeBytes && sizeBytes > MAX_PDF_BYTES) {
          console.warn(`Se omite ${file.name}: pesa ${(sizeBytes / 1e6).toFixed(1)}MB, supera el limite`);
          continue;
        }
        const buffer = await downloadPdfBuffer(drive, file.id);
        const { images, totalPages, pagesUsed } = await pdfBufferToPageImages(buffer, MAX_PAGES_PER_DOC);
        for (const imgBase64 of images) {
          documentParts.push({
            inlineData: {
              mimeType: 'image/png',
              data: imgBase64
            }
          });
        }
        sources.push({
          title: file.name + (totalPages > pagesUsed ? ` (primeras ${pagesUsed} de ${totalPages} paginas)` : ''),
          url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`
        });
      } catch (e) {
        console.error('Error leyendo/convirtiendo archivo', file.name, e.message);
      }
    }

    let webResultsBlock = '';
    if (documentParts.length === 0) {
      const webResults = await searchWeb(`Walchem ${message}`);
      if (webResults && webResults.length > 0) {
        webResultsBlock = '\n\nRESULTADOS DE BUSQUEDA WEB:\n' + webResults
          .map(r => `- ${r.title}: ${r.content} (${r.url})`)
          .join('\n');
      }
    }

    const systemPrompt = `Sos el asistente tecnico interno de Filsa, para el equipo que da soporte a equipos Walchem (bombas dosificadoras, controladores, sensores y accesorios de tratamiento de agua).

Tenes dos fuentes de informacion disponibles:
1. Los documentos PDF originales adjuntos a este mensaje (si hay alguno) - son los manuales reales de Walchem, con su texto, tablas, diagramas y esquemas completos. Esta es tu fuente PRINCIPAL y mas confiable para specs, procedimientos y troubleshooting.
2. Resultados de busqueda web (si se incluyen mas abajo) - usalos para complementar cuando no haya documentos adjuntos relevantes.

Respondé de forma directa y natural, combinando ambas fuentes segun corresponda, sin aclarar de cual proviene cada dato. Si genuinamente no encontras informacion confiable en ningun lado, decilo con honestidad en vez de inventar valores tecnicos, rangos o procedimientos de seguridad.

Se conciso, directo y accionable, como si hablaras con un tecnico que necesita resolver algo ahora. Usa listas numeradas para procedimientos paso a paso. Respondé siempre en español.${webResultsBlock}`;

    const currentTurnParts = [
      ...documentParts,
      { text: message }
    ];

    const contents = [
      ...historyToGeminiContents(history),
      { role: 'user', parts: currentTurnParts }
    ];

    const response = await generateWithRetry({
      model: GEMINI_MODEL,
      contents,
      config: { systemInstruction: systemPrompt }
    });

    const replyText = response.text || 'No pude generar una respuesta.';

    res.json({ reply: replyText, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Walchem Tech Assistant (Gemini) escuchando en puerto ${PORT}`);
});
