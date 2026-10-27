// Copia las librerías del navegador a public/vendor (se corre en postinstall y en el build de Vercel)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
const three = path.join(root, 'node_modules', 'three');

const files = {
  'three/build/three.module.js': 'build/three.module.js',
  'three/examples/jsm/loaders/STLLoader.js': 'examples/jsm/loaders/STLLoader.js',
  'three/examples/jsm/controls/OrbitControls.js': 'examples/jsm/controls/OrbitControls.js'
};

for (const [dest, src] of Object.entries(files)) {
  const target = path.join(out, dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(three, src), target);
}

// Cliente de Vercel Blob para subir archivos grandes directo desde el navegador
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'node_modules', '@vercel', 'blob', 'dist', 'client.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  outfile: path.join(out, 'blob-client.js'),
  logLevel: 'warning'
});

console.log('✔ Librerías copiadas a public/vendor');
