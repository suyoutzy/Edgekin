import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('extension requests only click-scoped permissions and injects its local bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.background.service_worker, 'background.js');

  let onClicked;
  let injection;
  const chrome = {
    action: {
      onClicked: { addListener: callback => { onClicked = callback; } },
      setBadgeText: async () => {},
    },
    scripting: { executeScript: async options => { injection = options; } },
  };
  const worker = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  runInNewContext(worker, { chrome });
  await onClicked({ id: 42 });
  assert.equal(injection.target.tabId, 42);
  assert.deepEqual(Array.from(injection.files), ['content.js']);
  assert.ok((await readFile(new URL('../extension/content.js', import.meta.url))).length > 0);
});
