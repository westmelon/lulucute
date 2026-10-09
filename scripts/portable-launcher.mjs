import { startPortableService } from '../src/core/portable-service.mjs';

startPortableService()
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
