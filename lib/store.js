'use strict';

// Almacenamiento de datos (configuración, diseños y votos).
// - Local: un archivo JSON en disco (para correrlo en una compu o servidor propio).
// - Vercel Blob: para Vercel, donde no hay disco persistente. Cada registro es un
//   archivo JSON propio; los votos se escriben sin permitir sobrescritura, así
//   que si dos votos de la misma persona llegan juntos, solo entra uno.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = { subidaAbierta: true, votacionAbierta: true, resultadosPublicos: false, unVotoPorDispositivo: true };

// ---------------------------------------------------------------------------
// Local (archivo JSON)
// ---------------------------------------------------------------------------
function localStore(dataDir) {
  const file = path.join(dataDir, 'db.json');
  fs.mkdirSync(dataDir, { recursive: true });

  let db;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    db = { settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }, designs: raw.designs || [], votes: raw.votes || [] };
  } catch {
    db = { settings: { ...DEFAULT_SETTINGS }, designs: [], votes: [] };
  }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    kind: 'local',
    async getSettings() { return { ...db.settings }; },
    async updateSettings(patch) { Object.assign(db.settings, patch); save(); return { ...db.settings }; },

    async listDesigns() { return db.designs.map(d => ({ ...d })); },
    async getDesign(id) { const d = db.designs.find(x => x.id === id); return d ? { ...d } : null; },
    async saveDesign(design) {
      const i = db.designs.findIndex(x => x.id === design.id);
      if (i === -1) db.designs.push(design); else db.designs[i] = design;
      save();
    },
    async deleteDesign(id) { db.designs = db.designs.filter(x => x.id !== id); save(); },

    async listVotes() { return db.votes.map(v => ({ ...v })); },
    // Registra el voto solo si esa persona (y, si se pide, ese dispositivo) no votó todavía
    async addVote(vote, { checkDevice }) {
      if (db.votes.some(v => v.key === vote.key)) return 'person';
      if (checkDevice && db.votes.some(v => v.device === vote.device)) return 'device';
      db.votes.push(vote);
      save();
      return 'ok';
    },
    async deleteVote(key) {
      const before = db.votes.length;
      db.votes = db.votes.filter(v => v.key !== key);
      save();
      return db.votes.length !== before;
    },
    async clearVotes() { db.votes = []; save(); }
  };
}

// ---------------------------------------------------------------------------
// Vercel Blob
// ---------------------------------------------------------------------------
function blobStore(token, secret) {
  const { put, list, del } = require('@vercel/blob');
  const opts = { access: 'public', token, contentType: 'application/json', cacheControlMaxAge: 60 * 60 * 24 * 365 };
  // Nombres de archivo no adivinables a partir del nombre de la persona
  const hash = s => crypto.createHmac('sha256', secret).update(s).digest('hex').slice(0, 40);

  async function listAll(prefix) {
    const blobs = [];
    let cursor;
    do {
      const page = await list({ prefix, cursor, limit: 1000, token });
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }

  async function readJson(blob) {
    const res = await fetch(blob.url);
    if (!res.ok) throw new Error(`No se pudo leer ${blob.pathname}`);
    return res.json();
  }

  // Los registros editables (diseños, configuración) se guardan como versiones
  // nuevas con sufijo aleatorio: así nunca se lee una copia vieja desde la caché.
  async function latestVersions(prefix) {
    const blobs = await listAll(prefix);
    const groups = new Map();
    for (const b of blobs) {
      const id = b.pathname.slice(prefix.length).split('/')[0];
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(b);
    }
    const stale = [];
    const latest = [];
    for (const list of groups.values()) {
      list.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      latest.push(list[0]);
      stale.push(...list.slice(1).map(b => b.url));
    }
    if (stale.length) del(stale, { token }).catch(() => {});
    return latest;
  }

  async function putVersion(prefix, id, data) {
    await put(`${prefix}${id}/v.json`, JSON.stringify(data), { ...opts, addRandomSuffix: true });
  }

  // Escritura que falla si el archivo ya existe (para que cada persona vote una sola vez)
  async function putOnce(pathname, data) {
    try {
      await put(pathname, JSON.stringify(data), { ...opts, addRandomSuffix: false, allowOverwrite: false });
      return true;
    } catch (err) {
      const existing = await list({ prefix: pathname, limit: 1, token });
      if (existing.blobs.some(b => b.pathname === pathname)) return false;
      throw err;
    }
  }

  return {
    kind: 'blob',
    async getSettings() {
      const [b] = await latestVersions('data/settings/');
      return { ...DEFAULT_SETTINGS, ...(b ? await readJson(b) : {}) };
    },
    async updateSettings(patch) {
      const next = { ...(await this.getSettings()), ...patch };
      await putVersion('data/settings/', 'main', next);
      return next;
    },

    async listDesigns() {
      return Promise.all((await latestVersions('data/designs/')).map(readJson));
    },
    async getDesign(id) {
      const blobs = await listAll(`data/designs/${id}/`);
      blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      return blobs[0] ? readJson(blobs[0]) : null;
    },
    async saveDesign(design) { await putVersion('data/designs/', design.id, design); },
    async deleteDesign(id) {
      const blobs = await listAll(`data/designs/${id}/`);
      if (blobs.length) await del(blobs.map(b => b.url), { token });
    },

    async listVotes() {
      return Promise.all((await listAll('data/votes/')).map(readJson));
    },
    async addVote(vote, { checkDevice }) {
      const votePath = `data/votes/${hash(vote.key)}.json`;
      if (!(await putOnce(votePath, vote))) return 'person';
      const newDevice = await putOnce(`data/devices/${hash(vote.device)}.json`, { at: vote.createdAt });
      if (checkDevice && !newDevice) {
        const [b] = (await list({ prefix: votePath, limit: 1, token })).blobs;
        if (b) await del(b.url, { token });
        return 'device';
      }
      return 'ok';
    },
    async deleteVote(key) {
      const [b] = (await list({ prefix: `data/votes/${hash(key)}.json`, limit: 1, token })).blobs;
      if (!b) return false;
      const vote = await readJson(b);
      await del(b.url, { token });
      const [dev] = (await list({ prefix: `data/devices/${hash(vote.device)}.json`, limit: 1, token })).blobs;
      if (dev) await del(dev.url, { token });
      return true;
    },
    async clearVotes() {
      const blobs = [...await listAll('data/votes/'), ...await listAll('data/devices/')];
      for (let i = 0; i < blobs.length; i += 500) await del(blobs.slice(i, i + 500).map(b => b.url), { token });
    }
  };
}

function createStore({ dataDir, blobToken, secret }) {
  return blobToken ? blobStore(blobToken, secret) : localStore(dataDir);
}

module.exports = { createStore };
