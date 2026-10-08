import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';

const extensionRoot = path.resolve('extension');

test('Chrome extension manifest uses local assets and restricted host permissions', async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.deepEqual(manifest.permissions, ['activeTab', 'tabs', 'nativeMessaging', 'storage', 'sidePanel']);
  assert.ok(manifest.key);
  assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  await access(path.join(extensionRoot, 'vendor', 'lucide.min.js'));

  const html = await readFile(path.join(extensionRoot, 'sidepanel.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  assert.doesNotMatch(html, /<script(?:\s[^>]*)?>\s*[^<]/i);
  assert.match(html, /<dialog id="confirm-dialog"/);
  assert.match(html, /id="headless-toggle"/);

  const script = await readFile(path.join(extensionRoot, 'sidepanel.js'), 'utf8');
  assert.match(script, /trash-2/);
  assert.match(script, /circle-x/);
  assert.match(script, /method: 'DELETE'/);
  assert.match(script, /\/cancel/);
  assert.match(script, /\/api\/settings\/browser/);
  assert.match(script, /supportedForum/);
  assert.match(script, /forum\.hosts/);
  assert.match(script, /ensure-local-service/);
  assert.match(script, /fetchWithServiceWake\('\/api\/events'/);

  const serviceWorker = await readFile(path.join(extensionRoot, 'service-worker.js'), 'utf8');
  assert.match(serviceWorker, /com\.resourcehub\.launcher/);
  assert.match(serviceWorker, /sendNativeMessage/);
});
