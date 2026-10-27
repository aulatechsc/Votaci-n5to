export async function api(url, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function showMsg(el, text, ok = false) {
  el.textContent = text;
  el.className = `msg show ${ok ? 'ok' : 'err'}`;
}

export function hideMsg(el) {
  el.className = 'msg';
}

export const DIV_COLORS = { A: 0xff8a6a, B: 0x3ee0c8 };

export function divBadge(div) {
  return `<span class="badge ${div.toLowerCase()}">5° ${esc(div)}</span>`;
}

// ---------- Parámetros de producción ----------
export function fmtTiempo(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const num = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });

export function fmtCosto(n) {
  return `$ ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// Chips con tiempo, material y costo (solo los que estén cargados)
export function paramsHtml(d, { empty = '' } = {}) {
  const chips = [];
  if (d.tiempoMin != null) chips.push(`<span class="param" title="Tiempo de impresión">⏱ ${fmtTiempo(d.tiempoMin)}</span>`);
  if (d.materialG != null) chips.push(`<span class="param" title="Material utilizado">🧵 ${num(d.materialG)} g</span>`);
  if (d.costo != null) chips.push(`<span class="param" title="Costo de producción">💲 ${num(d.costo)}</span>`);
  return chips.length ? `<div class="params">${chips.join('')}</div>` : empty;
}

// Campos del formulario (mismo markup en subida, alta y edición manual)
export function paramsFields(d = {}) {
  const v = x => (x == null ? '' : x);
  return `
    <div class="row3">
      <div class="field"><label>⏱ Tiempo (minutos)</label><input name="tiempoMin" type="number" min="0" step="1" inputmode="numeric" placeholder="Ej: 95" value="${v(d.tiempoMin)}"></div>
      <div class="field"><label>🧵 Material (gramos)</label><input name="materialG" type="number" min="0" step="0.1" inputmode="decimal" placeholder="Ej: 32" value="${v(d.materialG)}"></div>
      <div class="field"><label>💲 Costo ($)</label><input name="costo" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Ej: 1500" value="${v(d.costo)}"></div>
    </div>`;
}
