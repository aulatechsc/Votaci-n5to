# 🧊 Votación de diseños 3D · 5to año

Aplicación web para que los alumnos de 5to (divisiones **A** y **B**) suban sus archivos **STL** y después se vote a los mejores, con visor 3D integrado.

| Página | Link | Para qué |
|---|---|---|
| Subida | `/` | Cada alumno sube su `.stl` con nombre, apellido, nombre del objeto y división |
| Votación | `/votar` | Se ven todos los diseños en 3D y cada alumno elige **2** de su división (vota una sola vez) |
| Resultados | `/resultados` | Ranking público con los 2 ganadores por división (se activa desde el panel) |
| Panel | `/admin` | Gestión protegida con contraseña |

## Capturas

| Subida | Votación | Visor 3D |
|---|---|---|
| ![Subida](capturas/1-subir.png) | ![Votación](capturas/2-votar.png) | ![Visor 3D](capturas/3-visor-3d.png) |

| Resultados | Panel | Celular |
|---|---|---|
| ![Resultados](capturas/4-resultados.png) | ![Panel](capturas/6-admin-panel.png) | ![Celular](capturas/7-celular.png) |

## Reglas de votación

- Cada persona vota **una sola vez** y elige **exactamente 2 diseños** de **su propia división**.
- No se puede votar el propio diseño.
- Se controla por nombre + apellido + división (sin importar mayúsculas ni tildes) y, opcionalmente, un voto por dispositivo.
- Ganan los **2 más votados de cada división**. Si hay empate en el 2° puesto, el panel lo avisa.

## Panel de gestión (`/admin`)

- Abrir/cerrar la subida y la votación, publicar resultados.
- Activar/desactivar "un voto por dispositivo" (desactivalo si votan desde las compus compartidas de la escuela).
- Agregar diseños manualmente, editar datos, ver en 3D, descargar y eliminar.
- Ranking en vivo, lista de votantes, anular votos individuales o borrar todos.
- Links para compartir listos para copiar.

## Correr localmente

```bash
npm install
ADMIN_PASSWORD="una-clave-segura" npm start
# http://localhost:3000
```

Variables de entorno:

| Variable | Default | Descripción |
|---|---|---|
| `ADMIN_PASSWORD` | `admin5to` | Contraseña del panel. **Cambiala siempre.** |
| `PORT` | `3000` | Puerto |
| `DATA_DIR` | `./data` | Dónde se guardan `db.json` y los STL subidos |
| `MAX_FILE_MB` | `50` | Tamaño máximo por archivo |

## Publicarlo en internet

Hace falta un servidor con **disco persistente** (si no, los archivos se pierden al reiniciar).

**Render** (incluye `render.yaml`): New → Blueprint → elegir este repo → cargar `ADMIN_PASSWORD`. Usa un disco de 1 GB montado en `/var/data` (requiere plan pago).

**Railway**: New Project → Deploy from GitHub → agregar un Volume montado en `/data` y las variables `DATA_DIR=/data` y `ADMIN_PASSWORD`.

También funciona en cualquier VPS o compu de la escuela con Node 18+ (`npm install && npm start`).

## Estructura

```
server.js            API (Express) + almacenamiento en JSON
public/index.html    Subida
public/votar.html    Votación
public/resultados.html
public/admin.html    Panel
public/js/stl.js     Visor 3D y miniaturas (Three.js, servido localmente)
```
