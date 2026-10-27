const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const dst = path.join(__dirname, '..', 'public', 'vendor', 'chart.umd.js');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log('copied', dst);
