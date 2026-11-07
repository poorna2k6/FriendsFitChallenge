const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const copies = [
  ['node_modules/chart.js/dist/chart.umd.js', 'public/vendor/chart.umd.js'],
  ['node_modules/qrcode-generator/dist/qrcode.js', 'public/vendor/qrcode.js']
];
for (const [from, to] of copies) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(root, to));
  console.log('copied', to);
}
