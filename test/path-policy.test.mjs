import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildTargetDirectory, sanitizeSegment } from '../src/core/path-policy.mjs';

test('sanitizeSegment removes filesystem control characters', () => {
  assert.equal(sanitizeSegment('A/B:C*D?'), 'A_B_C_D_');
  assert.equal(sanitizeSegment('..'), 'unknown');
  assert.equal(sanitizeSegment('CON'), '_CON');
});

test('buildTargetDirectory keeps the result below the configured root', () => {
  const root = path.resolve('/tmp/resource-hub');
  const target = buildTargetDirectory(root, {
    forum: '../../HiFiTi',
    section: '华语',
    threadTitle: '丁当《猜不透》'
  });
  assert.equal(target, path.join(root, '.._.._HiFiTi', '华语', '丁当《猜不透》'));
});
