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
