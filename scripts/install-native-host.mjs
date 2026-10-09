#!/usr/bin/env node
import { installNativeHost } from '../src/core/native-host-registration.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config' || !args[1])) {
    throw new Error('Usage: npm run install:native-host -- [--config config.json]');
  }
  const { extensionId, manifestPath } = await installNativeHost({ configPath: args[1] });
  console.log(`Native host installed for extension ${extensionId}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log('Reload the unpacked extension in chrome://extensions/.');
  console.log(`If its ID is not ${extensionId}, remove it and load the extension directory again.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
