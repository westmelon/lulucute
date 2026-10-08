import { copyFile, mkdir } from 'node:fs/promises';

const targetDirectory = new URL('../extension/vendor/', import.meta.url);
await mkdir(targetDirectory, { recursive: true });
await copyFile(
  new URL('../node_modules/lucide/dist/umd/lucide.min.js', import.meta.url),
  new URL('lucide.min.js', targetDirectory)
);
console.log('Extension vendor assets are ready');
