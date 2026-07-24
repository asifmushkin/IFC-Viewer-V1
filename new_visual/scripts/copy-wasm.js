const fs = require('fs');
const path = require('path');

const wasmSource = path.resolve(__dirname, '../node_modules/web-ifc/');
const wasmTarget = path.resolve(__dirname, '../assets/wasm/');

if (!fs.existsSync(wasmSource)) {
  console.warn('web-ifc package not found at', wasmSource);
  process.exit(0);
}

if (!fs.existsSync(wasmTarget)) {
  fs.mkdirSync(wasmTarget, { recursive: true });
}

const wasmFiles = fs.readdirSync(wasmSource).filter((file) => file.endsWith('.wasm'));
for (const file of wasmFiles) {
  fs.copyFileSync(path.join(wasmSource, file), path.join(wasmTarget, file));
}

console.log('Copied web-ifc WASM files:', wasmFiles.join(', '));
