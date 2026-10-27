'use strict';

const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./lib/store');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin5to';
const SECRET = process.env.SESSION_SECRET || `votacion5to|${ADMIN_PASSWORD}`;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const ON_VERCEL = !!process.env.VERCEL;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 50);
const DIVISIONES = ['A', 'B'];
const VOTOS_POR_PERSONA = 2;
const SETTING_KEYS = ['subidaAbierta', 'votacionAbierta', 'resultadosPublicos', 'unVotoPorDispositivo'];

// En Vercel no hay disco: los archivos y datos van a Vercel Blob
const USE_BLOB = !!BLOB_TOKEN;
const MISCONFIGURED = ON_VERCEL && !USE_BLOB;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD no está definida: se usa la contraseña por defecto "admin5to". Cambiala antes de publicar.');
}
if (MISCONFIGURED) {
  console.error('❌ Falta BLOB_READ_WRITE_TOKEN: conectá un Blob Store al proyecto de Vercel.');
}

const store = MISCONFIGURED ? null : createStore({ dataDir: DATA_DIR, blobToken: BLOB_TOKEN, secret: SECRET });
if (!USE_BLOB && !MISCONFIGURED) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const blob = USE_BLOB ? require('@vercel/blob') : null;
const { handleUpload } = USE_BLOB ? require('@vercel/blob/client') : {};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Express 4 no captura errores de funciones async
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clean(str, max = 60) {
  return String(str || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Normaliza nombres para detectar duplicados: "José  PÉREZ" === "jose perez"
function normalize(str) {
  return clean(str, 200)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function personKey(nombre, apellido, division) {
  return `${normalize(division)}|${normalize(apellido)}|${normalize(nombre)}`;
}

// Parámetros de producción (opcionales, cargados a mano): minutos, gramos y costo
const PARAMS = { tiempoMin: 'tiempo', materialG: 'material', costo: 'costo' };

function parseParam(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new HttpError(400, `El valor de ${label} no es válido.`);
  return Math.round(n * 100) / 100;
}

function parseParams(body) {
  const out = {};
  for (const [k, label] of Object.entries(PARAMS)) out[k] = parseParam(body[k], label);
  return out;
}

function fileUrl(d) {
  return d.url || `/files/${d.file}`;
}

function publicDesign(d) {
  return {
    id: d.id,
    nombre: d.nombre,
    apellido: d.apellido,
    objeto: d.objeto,
    division: d.division,
    tiempoMin: d.tiempoMin ?? null,
    materialG: d.materialG ?? null,
    costo: d.costo ?? null,
    archivo: fileUrl(d),
    descarga: d.url ? `${d.url}?download=1` : fileUrl(d),
    tamano: d.size,
    creado: d.createdAt
  };
}

async function results() {
  const [designs, votes] = await Promise.all([store.listDesigns(), store.listVotes()]);
  const counts = {};
  for (const d of designs) counts[d.id] = 0;
  for (const v of votes) {
    for (const id of v.designIds) {
      if (id in counts) counts[id]++;
    }
  }
  const out = {};
  for (const div of DIVISIONES) {
    out[div] = designs
      .filter(d => d.division === div)
      .map(d => ({ ...publicDesign(d), votos: counts[d.id] }))
      .sort((a, b) => b.votos - a.votos || a.apellido.localeCompare(b.apellido));
  }
  return { out, votes };
}

async function removeFile(d) {
  if (d.url && USE_BLOB) {
    await blob.del(d.url, { token: BLOB_TOKEN }).catch(() => {});
  } else if (d.file) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(d.file)), () => {});
  }
}

// head: primeros bytes del archivo; size: tamaño total
function isStl(head, size) {
  if (!head || size < 15) return false;
  // STL binario: 80 bytes de cabecera + uint32 con la cantidad de triángulos
  if (head.length >= 84 && 84 + head.readUInt32LE(80) * 50 === size) return true;
  // STL ASCII
  const text = head.subarray(0, 4096).toString('utf8').trim().toLowerCase();
  return text.startsWith('solid') && /facet|endsolid/.test(text);
}

// ---------------------------------------------------------------------------
// Alta de diseños
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (!/\.stl$/i.test(file.originalname)) {
      return cb(new HttpError(400, 'El archivo tiene que ser .stl'));
    }
    cb(null, true);
  }
});

// Valida los datos del formulario (sin el archivo)
async function validateFields(body, { checkDuplicate }) {
  const fields = {
    nombre: clean(body.nombre),
    apellido: clean(body.apellido),
    objeto: clean(body.objeto, 80),
    division: clean(body.division, 1).toUpperCase(),
    ...parseParams(body)
  };
  if (!fields.nombre || !fields.apellido || !fields.objeto) throw new HttpError(400, 'Completá nombre, apellido y nombre del objeto.');
  if (!DIVISIONES.includes(fields.division)) throw new HttpError(400, 'La división tiene que ser A o B.');

  if (checkDuplicate) {
    const key = personKey(fields.nombre, fields.apellido, fields.division);
    const designs = await store.listDesigns();
    if (designs.some(d => personKey(d.nombre, d.apellido, d.division) === key)) {
      throw new HttpError(409, 'Ya hay un diseño subido con ese nombre en esa división. Si necesitás cambiarlo, hablá con el profe.');
    }
  }
  return fields;
}

// Archivo subido directo a Vercel Blob desde el navegador: se verifica que sea nuestro y un STL
async function checkBlobFile(url) {
  let info;
  try {
    info = await blob.head(url, { token: BLOB_TOKEN });
  } catch {
    throw new HttpError(400, 'No se encontró el archivo subido. Probá de nuevo.');
  }
  if (!info.pathname.startsWith('stl/')) throw new HttpError(400, 'Archivo inválido.');
  const fail = async msg => {
    await blob.del(info.url, { token: BLOB_TOKEN }).catch(() => {});
    throw new HttpError(400, msg);
  };
  if (info.size > MAX_FILE_MB * 1024 * 1024) await fail(`El archivo supera los ${MAX_FILE_MB} MB.`);
  const res = await fetch(info.url, { headers: { Range: 'bytes=0-4095' } });
  const head = Buffer.from(await res.arrayBuffer()).subarray(0, 4096);
  if (!isStl(head, info.size)) await fail('El archivo no parece ser un STL válido.');
  return info;
}

async function createDesign(req, { checkDuplicate }) {
  const fields = await validateFields(req.body, { checkDuplicate });
  const id = crypto.randomUUID();
  const design = { id, ...fields, createdAt: new Date().toISOString() };

  if (req.file) {
    // Subida local (multipart)
    if (USE_BLOB) throw new HttpError(400, 'Subida inválida.');
    if (!isStl(req.file.buffer, req.file.size)) throw new HttpError(400, 'El archivo no parece ser un STL válido.');
    design.file = `${id}.stl`;
    design.size = req.file.size;
    design.originalName = clean(req.file.originalname, 120);
    fs.writeFileSync(path.join(UPLOAD_DIR, design.file), req.file.buffer);
  } else if (USE_BLOB && req.body.blobUrl) {
    const info = await checkBlobFile(String(req.body.blobUrl));
    design.url = info.url;
    design.size = info.size;
    design.originalName = clean(info.pathname.split('/').pop(), 120);
  } else {
    throw new HttpError(400, 'Falta el archivo STL.');
  }

  await store.saveDesign(design);
  return design;
}

// ---------------------------------------------------------------------------
// Sesión de administrador: token firmado (funciona sin memoria compartida)
// ---------------------------------------------------------------------------
const SESSION_MS = 1000 * 60 * 60 * 8;

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('hex');
}

function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAdmin(req) {
  const [exp, mac] = String(req.cookies.admin_token || '').split('.');
  return !!exp && !!mac && safeEqual(mac, sign(exp)) && Number(exp) > Date.now();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Sesión vencida. Ingresá de nuevo.' });
  next();
}

// Límite simple de intentos de login por IP
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, since: now };
  if (now - entry.since > 15 * 60 * 1000) {
    entry.count = 0;
    entry.since = now;
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count > 10;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

if (!USE_BLOB) {
  app.use('/files', express.static(UPLOAD_DIR, {
    setHeaders(res) {
      res.setHeader('Content-Type', 'model/stl');
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }));
}
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', (req, res, next) => {
  if (MISCONFIGURED) return res.status(500).json({ error: 'Falta configurar el almacenamiento (Vercel Blob) en el proyecto.' });
  next();
});

const cookieOpts = req => ({ httpOnly: true, secure: req.secure, path: '/' });

// ---- Público --------------------------------------------------------------
app.get('/api/config', ah(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ...(await store.getSettings()),
    divisiones: DIVISIONES,
    votosPorPersona: VOTOS_POR_PERSONA,
    maxFileMb: MAX_FILE_MB,
    almacenamiento: USE_BLOB ? 'blob' : 'local'
  });
}));

app.get('/api/designs', ah(async (req, res) => {
  const division = clean(req.query.division, 1).toUpperCase();
  let list = await store.listDesigns();
  if (division) list = list.filter(d => d.division === division);
  list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.set('Cache-Control', 'no-store');
  res.json(list.map(publicDesign));
}));

async function requireUploadsOpen(req) {
  if (isAdmin(req)) return;
  if (!(await store.getSettings()).subidaAbierta) throw new HttpError(403, 'La subida de diseños está cerrada.');
}

// Chequeo previo (Vercel): valida los datos antes de subir el archivo
app.post('/api/designs/check', ah(async (req, res) => {
  await requireUploadsOpen(req);
  await validateFields(req.body, { checkDuplicate: !(isAdmin(req) && req.body.admin) });
  res.json({ ok: true });
}));

// Token para que el navegador suba el STL directo a Vercel Blob (sin el límite de 4,5 MB de Vercel)
app.post('/api/upload-token', ah(async (req, res) => {
  if (!USE_BLOB) throw new HttpError(404, 'No disponible.');
  const json = await handleUpload({
    token: BLOB_TOKEN,
    request: req,
    body: req.body,
    onBeforeGenerateToken: async pathname => {
      await requireUploadsOpen(req);
      if (!/^stl\/[^/]+\.stl$/i.test(pathname)) throw new HttpError(400, 'El archivo tiene que ser .stl');
      return {
        allowedContentTypes: ['model/stl', 'application/octet-stream'],
        maximumSizeInBytes: MAX_FILE_MB * 1024 * 1024,
        addRandomSuffix: true
      };
    }
  });
  res.json(json);
}));

app.post('/api/designs', upload.single('archivo'), ah(async (req, res) => {
  await requireUploadsOpen(req);
  const design = await createDesign(req, { checkDuplicate: true });
  res.status(201).json(publicDesign(design));
}));

app.post('/api/vote', ah(async (req, res) => {
  const settings = await store.getSettings();
  if (!settings.votacionAbierta) throw new HttpError(403, 'La votación está cerrada.');

  const nombre = clean(req.body.nombre);
  const apellido = clean(req.body.apellido);
  const division = clean(req.body.division, 1).toUpperCase();
  const ids = Array.isArray(req.body.designIds) ? [...new Set(req.body.designIds.map(String))] : [];

  if (!nombre || !apellido) throw new HttpError(400, 'Poné tu nombre y apellido para votar.');
  if (!DIVISIONES.includes(division)) throw new HttpError(400, 'Elegí tu división.');
  if (ids.length !== VOTOS_POR_PERSONA) throw new HttpError(400, `Tenés que elegir exactamente ${VOTOS_POR_PERSONA} diseños distintos.`);

  const designs = await store.listDesigns();
  const chosen = ids.map(id => designs.find(d => d.id === id));
  if (chosen.some(d => !d)) throw new HttpError(400, 'Alguno de los diseños elegidos ya no existe. Recargá la página.');
  if (chosen.some(d => d.division !== division)) throw new HttpError(400, 'Solo podés votar diseños de tu división.');

  const key = personKey(nombre, apellido, division);
  if (chosen.some(d => personKey(d.nombre, d.apellido, d.division) === key)) {
    throw new HttpError(400, 'No vale votarte a vos mismo 😉');
  }

  // Además del nombre, se puede limitar a un voto por dispositivo/navegador
  // (desactivable desde el panel si votan desde compus compartidas)
  const device = clean(req.cookies.voter_device, 64) || crypto.randomUUID();
  const result = await store.addVote(
    { key, nombre, apellido, division, designIds: ids, device, createdAt: new Date().toISOString() },
    { checkDevice: settings.unVotoPorDispositivo }
  );
  if (result === 'person') throw new HttpError(409, 'Ya votaste. Cada persona puede votar una sola vez.');
  if (result === 'device') throw new HttpError(409, 'Desde este dispositivo ya se votó. Si es un error, avisale al profe.');

  res.cookie('voter_device', device, { ...cookieOpts(req), sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
  res.status(201).json({ ok: true });
}));

app.get('/api/results', ah(async (req, res) => {
  if (!(await store.getSettings()).resultadosPublicos) throw new HttpError(403, 'Los resultados todavía no se publicaron.');
  res.set('Cache-Control', 'no-store');
  res.json((await results()).out);
}));

// ---- Administración -------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  if (tooManyAttempts(req.ip)) throw new HttpError(429, 'Demasiados intentos. Esperá unos minutos.');
  if (!safeEqual((req.body && req.body.password) || '', ADMIN_PASSWORD)) throw new HttpError(401, 'Contraseña incorrecta.');
  loginAttempts.delete(req.ip);
  res.cookie('admin_token', makeToken(), { ...cookieOpts(req), sameSite: 'strict', maxAge: SESSION_MS });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/state', requireAdmin, ah(async (req, res) => {
  const [{ out, votes }, settings] = await Promise.all([results(), store.getSettings()]);
  res.set('Cache-Control', 'no-store');
  res.json({
    settings,
    resultados: out,
    votos: votes.map(v => ({
      key: v.key,
      nombre: v.nombre,
      apellido: v.apellido,
      division: v.division,
      designIds: v.designIds,
      creado: v.createdAt
    }))
  });
}));

app.patch('/api/admin/settings', requireAdmin, ah(async (req, res) => {
  const patch = {};
  for (const k of SETTING_KEYS) {
    if (typeof req.body[k] === 'boolean') patch[k] = req.body[k];
  }
  res.json(await store.updateSettings(patch));
}));

app.post('/api/admin/designs', requireAdmin, upload.single('archivo'), ah(async (req, res) => {
  const design = await createDesign(req, { checkDuplicate: false });
  res.status(201).json(publicDesign(design));
}));

app.patch('/api/admin/designs/:id', requireAdmin, ah(async (req, res) => {
  const d = await store.getDesign(req.params.id);
  if (!d) throw new HttpError(404, 'Diseño no encontrado.');
  for (const k of ['nombre', 'apellido', 'objeto']) {
    if (req.body[k] !== undefined) {
      const val = clean(req.body[k], k === 'objeto' ? 80 : 60);
      if (!val) throw new HttpError(400, `El campo ${k} no puede quedar vacío.`);
      d[k] = val;
    }
  }
  for (const [k, label] of Object.entries(PARAMS)) {
    if (req.body[k] !== undefined) d[k] = parseParam(req.body[k], label);
  }
  if (req.body.division !== undefined) {
    const div = clean(req.body.division, 1).toUpperCase();
    if (!DIVISIONES.includes(div)) throw new HttpError(400, 'La división tiene que ser A o B.');
    d.division = div;
  }
  await store.saveDesign(d);
  res.json(publicDesign(d));
}));

app.delete('/api/admin/designs/:id', requireAdmin, ah(async (req, res) => {
  const d = await store.getDesign(req.params.id);
  if (!d) throw new HttpError(404, 'Diseño no encontrado.');
  await store.deleteDesign(d.id);
  await removeFile(d);
  res.json({ ok: true });
}));

app.delete('/api/admin/votes/:key', requireAdmin, ah(async (req, res) => {
  if (!(await store.deleteVote(req.params.key))) throw new HttpError(404, 'Voto no encontrado.');
  res.json({ ok: true });
}));

app.delete('/api/admin/votes', requireAdmin, ah(async (req, res) => {
  await store.clearVotes();
  res.json({ ok: true });
}));

// ---- Errores --------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera los ${MAX_FILE_MB} MB.` : 'Error al subir el archivo.';
    return res.status(400).json({ error: msg });
  }
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Error interno del servidor.' : err.message });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Servidor listo en http://localhost:${PORT}`);
    console.log(`   Subir diseños:  http://localhost:${PORT}/`);
    console.log(`   Votación:       http://localhost:${PORT}/votar`);
    console.log(`   Panel admin:    http://localhost:${PORT}/admin`);
  });
}
