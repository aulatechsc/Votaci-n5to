'use strict';

const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin5to';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 50);
const DIVISIONES = ['A', 'B'];
const VOTOS_POR_PERSONA = 2;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD no está definida: se usa la contraseña por defecto "admin5to". Cambiala antes de publicar.');
}

// ---------------------------------------------------------------------------
// "Base de datos" en un archivo JSON (escritura atómica)
// ---------------------------------------------------------------------------
const DEFAULT_DB = {
  settings: { subidaAbierta: true, votacionAbierta: true, resultadosPublicos: false, unVotoPorDispositivo: true },
  designs: [],
  votes: []
};

function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      settings: { ...DEFAULT_DB.settings, ...(raw.settings || {}) },
      designs: raw.designs || [],
      votes: raw.votes || []
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

let db = loadDb();

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
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

function personKey(nombre, apellido, division) {
  return `${normalize(division)}|${normalize(apellido)}|${normalize(nombre)}`;
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
    archivo: `/files/${d.file}`,
    tamano: d.size,
    creado: d.createdAt
  };
}

function voteCounts() {
  const counts = {};
  for (const d of db.designs) counts[d.id] = 0;
  for (const v of db.votes) {
    for (const id of v.designIds) {
      if (id in counts) counts[id]++;
    }
  }
  return counts;
}

function results() {
  const counts = voteCounts();
  const out = {};
  for (const div of DIVISIONES) {
    out[div] = db.designs
      .filter(d => d.division === div)
      .map(d => ({ ...publicDesign(d), votos: counts[d.id] }))
      .sort((a, b) => b.votos - a.votos || a.apellido.localeCompare(b.apellido));
  }
  return out;
}

function removeFile(file) {
  if (!file) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(file)), () => {});
}

function isStl(buffer) {
  if (!buffer || buffer.length < 15) return false;
  // STL binario: 80 bytes de cabecera + uint32 con la cantidad de triángulos
  if (buffer.length >= 84) {
    const tris = buffer.readUInt32LE(80);
    if (84 + tris * 50 === buffer.length) return true;
  }
  // STL ASCII
  const head = buffer.slice(0, 1024).toString('utf8').trim().toLowerCase();
  return head.startsWith('solid') && /facet|endsolid/.test(buffer.slice(0, 4096).toString('utf8').toLowerCase());
}

// ---------------------------------------------------------------------------
// Subida de archivos
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createDesign(body, file, { skipDuplicateCheck = false } = {}) {
  const nombre = clean(body.nombre);
  const apellido = clean(body.apellido);
  const objeto = clean(body.objeto, 80);
  const division = clean(body.division, 1).toUpperCase();
  const params = parseParams(body);

  if (!nombre || !apellido || !objeto) throw new HttpError(400, 'Completá nombre, apellido y nombre del objeto.');
  if (!DIVISIONES.includes(division)) throw new HttpError(400, 'La división tiene que ser A o B.');
  if (!file) throw new HttpError(400, 'Falta el archivo STL.');
  if (!isStl(file.buffer)) throw new HttpError(400, 'El archivo no parece ser un STL válido.');

  const key = personKey(nombre, apellido, division);
  if (!skipDuplicateCheck && db.designs.some(d => personKey(d.nombre, d.apellido, d.division) === key)) {
    throw new HttpError(409, 'Ya hay un diseño subido con ese nombre en esa división. Si necesitás cambiarlo, hablá con el profe.');
  }

  const id = crypto.randomUUID();
  const fileName = `${id}.stl`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), file.buffer);

  const design = {
    id,
    nombre,
    apellido,
    objeto,
    division,
    ...params,
    file: fileName,
    originalName: clean(file.originalname, 120),
    size: file.size,
    createdAt: new Date().toISOString()
  };
  db.designs.push(design);
  saveDb();
  return design;
}

// ---------------------------------------------------------------------------
// Sesiones de administrador (en memoria)
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> expira (ms)
const SESSION_MS = 1000 * 60 * 60 * 8;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
  const token = req.cookies.admin_token;
  const exp = token && sessions.get(token);
  if (!exp || exp < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Sesión vencida. Ingresá de nuevo.' });
  }
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

app.use('/files', express.static(UPLOAD_DIR, {
  setHeaders(res) {
    res.setHeader('Content-Type', 'model/stl');
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---- Público --------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ ...db.settings, divisiones: DIVISIONES, votosPorPersona: VOTOS_POR_PERSONA, maxFileMb: MAX_FILE_MB });
});

app.get('/api/designs', (req, res) => {
  const division = clean(req.query.division, 1).toUpperCase();
  let list = db.designs;
  if (division) list = list.filter(d => d.division === division);
  res.json(list.map(publicDesign));
});

app.post('/api/designs', upload.single('archivo'), (req, res) => {
  if (!db.settings.subidaAbierta) throw new HttpError(403, 'La subida de diseños está cerrada.');
  const design = createDesign(req.body, req.file);
  res.status(201).json(publicDesign(design));
});

app.post('/api/vote', (req, res) => {
  if (!db.settings.votacionAbierta) throw new HttpError(403, 'La votación está cerrada.');

  const nombre = clean(req.body.nombre);
  const apellido = clean(req.body.apellido);
  const division = clean(req.body.division, 1).toUpperCase();
  const ids = Array.isArray(req.body.designIds) ? [...new Set(req.body.designIds.map(String))] : [];

  if (!nombre || !apellido) throw new HttpError(400, 'Poné tu nombre y apellido para votar.');
  if (!DIVISIONES.includes(division)) throw new HttpError(400, 'Elegí tu división.');
  if (ids.length !== VOTOS_POR_PERSONA) throw new HttpError(400, `Tenés que elegir exactamente ${VOTOS_POR_PERSONA} diseños distintos.`);

  const chosen = ids.map(id => db.designs.find(d => d.id === id));
  if (chosen.some(d => !d)) throw new HttpError(400, 'Alguno de los diseños elegidos ya no existe. Recargá la página.');
  if (chosen.some(d => d.division !== division)) throw new HttpError(400, 'Solo podés votar diseños de tu división.');

  const key = personKey(nombre, apellido, division);
  if (chosen.some(d => personKey(d.nombre, d.apellido, d.division) === key)) {
    throw new HttpError(400, 'No vale votarte a vos mismo 😉');
  }
  if (db.votes.some(v => v.key === key)) throw new HttpError(409, 'Ya votaste. Cada persona puede votar una sola vez.');

  // Además del nombre, se puede limitar a un voto por dispositivo/navegador
  // (desactivable desde el panel si votan desde compus compartidas)
  const deviceId = clean(req.cookies.voter_device, 64);
  if (db.settings.unVotoPorDispositivo && deviceId && db.votes.some(v => v.device === deviceId)) {
    throw new HttpError(409, 'Desde este dispositivo ya se votó. Si es un error, avisale al profe.');
  }
  const device = deviceId || crypto.randomUUID();

  db.votes.push({ key, nombre, apellido, division, designIds: ids, device, createdAt: new Date().toISOString() });
  saveDb();

  res.cookie('voter_device', device, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
  res.status(201).json({ ok: true });
});

app.get('/api/results', (req, res) => {
  if (!db.settings.resultadosPublicos) throw new HttpError(403, 'Los resultados todavía no se publicaron.');
  res.json(results());
});

// ---- Administración -------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  if (tooManyAttempts(req.ip)) throw new HttpError(429, 'Demasiados intentos. Esperá unos minutos.');
  if (!safeEqual(req.body.password || '', ADMIN_PASSWORD)) throw new HttpError(401, 'Contraseña incorrecta.');
  loginAttempts.delete(req.ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.cookie('admin_token', token, { httpOnly: true, sameSite: 'strict', maxAge: SESSION_MS });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  sessions.delete(req.cookies.admin_token);
  res.clearCookie('admin_token');
  res.json({ ok: true });
});

app.get('/api/admin/state', requireAdmin, (req, res) => {
  res.json({
    settings: db.settings,
    resultados: results(),
    votos: db.votes.map(v => ({
      key: v.key,
      nombre: v.nombre,
      apellido: v.apellido,
      division: v.division,
      designIds: v.designIds,
      creado: v.createdAt
    }))
  });
});

app.patch('/api/admin/settings', requireAdmin, (req, res) => {
  for (const k of Object.keys(DEFAULT_DB.settings)) {
    if (typeof req.body[k] === 'boolean') db.settings[k] = req.body[k];
  }
  saveDb();
  res.json(db.settings);
});

app.post('/api/admin/designs', requireAdmin, upload.single('archivo'), (req, res) => {
  const design = createDesign(req.body, req.file, { skipDuplicateCheck: true });
  res.status(201).json(publicDesign(design));
});

app.patch('/api/admin/designs/:id', requireAdmin, (req, res) => {
  const d = db.designs.find(x => x.id === req.params.id);
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
  saveDb();
  res.json(publicDesign(d));
});

app.delete('/api/admin/designs/:id', requireAdmin, (req, res) => {
  const idx = db.designs.findIndex(x => x.id === req.params.id);
  if (idx === -1) throw new HttpError(404, 'Diseño no encontrado.');
  const [d] = db.designs.splice(idx, 1);
  saveDb();
  removeFile(d.file);
  res.json({ ok: true });
});

app.delete('/api/admin/votes/:key', requireAdmin, (req, res) => {
  const before = db.votes.length;
  db.votes = db.votes.filter(v => v.key !== req.params.key);
  if (db.votes.length === before) throw new HttpError(404, 'Voto no encontrado.');
  saveDb();
  res.json({ ok: true });
});

app.delete('/api/admin/votes', requireAdmin, (req, res) => {
  db.votes = [];
  saveDb();
  res.json({ ok: true });
});

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

app.listen(PORT, () => {
  console.log(`✅ Servidor listo en http://localhost:${PORT}`);
  console.log(`   Subir diseños:  http://localhost:${PORT}/`);
  console.log(`   Votación:       http://localhost:${PORT}/votar`);
  console.log(`   Panel admin:    http://localhost:${PORT}/admin`);
});
