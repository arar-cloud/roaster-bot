import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('=== Diagnostic Report ===');
console.log('Node version:', process.version);
console.log('Current directory:', process.cwd());
console.log('Script directory:', __dirname);

const targetPath = resolve(__dirname, '../src/index.js');
console.log('Resolved path:', targetPath);
console.log('Target exists:', fs.existsSync(targetPath));

const sourceDir = resolve(__dirname, '../src');
console.log('Source directory exists:', fs.existsSync(sourceDir));

try {
  if (fs.existsSync(sourceDir)) {
    console.log('Files in src/:', fs.readdirSync(sourceDir));
  } else {
    console.log('⚠️  src/ directory not found. Check repository structure.');
  }
} catch (err) {
  console.error('❌ Error reading source directory:', err.message);
}
