import { esc, divBadge, DIV_COLORS } from '/js/common.js';
import { createViewer } from '/js/stl.js';

// Modal con visor 3D interactivo
let modal = null;
let viewer = null;

function ensure() {
  if (modal) return modal;
  modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="mTitle">
      <div class="modal-head">
        <div>
          <h3 id="mTitle"></h3>
          <div id="mSub" style="color:var(--muted)"></div>
        </div>
        <button class="xbtn" aria-label="Cerrar">✕</button>
      </div>
      <div class="modal-body">
        <div class="viewer" id="mViewer"></div>
        <p class="hint">Arrastrá para girar · rueda o pellizco para hacer zoom</p>
        <div id="mActions" style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  modal.querySelector('.xbtn').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('show')) closeModal(); });
  return modal;
}

export function openModal(design, actionsHtml = '') {
  ensure();
  modal.querySelector('#mTitle').textContent = design.objeto;
  modal.querySelector('#mSub').innerHTML = `${esc(design.nombre)} ${esc(design.apellido)} · ${divBadge(design.division)}`;
  modal.querySelector('#mActions').innerHTML = actionsHtml;
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
  if (viewer) viewer.dispose();
  viewer = createViewer(modal.querySelector('#mViewer'), { color: DIV_COLORS[design.division] });
  viewer.load(design.archivo).catch(() => {
    modal.querySelector('#mViewer').innerHTML = '<div class="empty-state">No se pudo cargar el modelo 😕</div>';
  });
  return modal.querySelector('#mActions');
}

export function closeModal() {
  if (!modal) return;
  modal.classList.remove('show');
  document.body.style.overflow = '';
  if (viewer) { viewer.dispose(); viewer = null; }
}
