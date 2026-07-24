const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'node_modules', 'web-ifc');
const targetDir = path.join(root, 'assets', 'wasm');

fs.mkdirSync(targetDir, { recursive: true });

for (const file of ['web-ifc.wasm', 'web-ifc-mt.wasm']) {
  const source = path.join(sourceDir, file);
  const target = path.join(targetDir, file);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, target);
  }
}
