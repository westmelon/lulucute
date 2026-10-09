import { sample } from './lib/sample.mjs';

export function createAdapter() {
  return { match: () => false, resolve: async () => sample };
}
