import { esc } from '/js/common.js';

// Dibuja el ranking por división. Los 2 primeros de cada división son los ganadores.
export function renderPodium(container, resultados, { onView } = {}) {
  container.innerHTML = ['A', 'B'].map(div => {
    const list = resultados[div] || [];
    const max = Math.max(1, ...list.map(d => d.votos));
    // Empate si el 3ro tiene los mismos votos que el 2do
    const tieAtCutoff = list.length > 2 && list[1].votos > 0 && list[2].votos === list[1].votos;

    const rows = list.length
      ? list.map((d, i) => {
          const win = i < 2 && d.votos > 0;
          return `
            <div class="rank ${win ? 'win' : ''} ${i === 1 ? 'second' : ''}" data-id="${esc(d.id)}">
              <div class="pos">${win ? (i === 0 ? '🥇' : '🥈') : i + 1}</div>
              <div class="grow">
                <div><b>${esc(d.objeto)}</b></div>
                <div style="color:var(--muted);font-size:.9rem">${esc(d.nombre)} ${esc(d.apellido)}</div>
                <div class="bar"><i style="width:${(d.votos / max) * 100}%"></i></div>
              </div>
              <div class="votes-n">${d.votos}</div>
              ${onView ? `<button class="btn ghost sm" data-view="${esc(d.id)}" title="Ver en 3D">👁</button>` : ''}
            </div>`;
        }).join('')
      : '<div class="empty-state" style="padding:20px">Sin diseños todavía</div>';

    return `
      <div class="podium-col">
        <h3><span class="badge ${div.toLowerCase()}">5° ${div}</span> Ranking</h3>
        ${rows}
        ${tieAtCutoff ? '<div class="tie">⚠️ Hay un empate en el segundo puesto: definan el desempate.</div>' : ''}
      </div>`;
  }).join('');

  if (onView) {
    container.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.view;
        const d = [...(resultados.A || []), ...(resultados.B || [])].find(x => x.id === id);
        if (d) onView(d);
      });
    });
  }
}
