const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSearchReplaceArguments,
  parseReplacementManifest,
  parseArgs,
} = require('../src/cli');

test('WordPress replacement manifest validates ordered domain pairs', () => {
  const manifest = parseReplacementManifest({
    schema: 'ioweb-wordpress-import-replacements/v1',
    replacements: [{ from: 'https://old.example', to: 'https://new.ddev.site' }],
  }, 'manifest.json');

  assert.equal(manifest.replacements[0].from, 'https://old.example');
  assert.equal(manifest.replacements[0].to, 'https://new.ddev.site');
});

test('WordPress replacements use precise WP-CLI mode and skip guid by default', () => {
  const args = buildSearchReplaceArguments(
    { from: 'old.example', to: 'new.ddev.site' },
    { includeGuid: false },
    {},
    true,
  );

  assert.deepEqual(args, [
    '--skip-plugins',
    '--skip-themes',
    'search-replace',
    'old.example',
    'new.ddev.site',
    '--all-tables-with-prefix',
    '--precise',
    '--recurse-objects',
    '--skip-columns=guid',
    '--dry-run',
  ]);
});

test('WordPress replacement command can explicitly include guid', () => {
  const args = buildSearchReplaceArguments(
    { from: 'old.example', to: 'new.ddev.site' },
    { includeGuid: false },
    { 'include-guid': true },
    false,
  );

  assert.ok(!args.includes('--skip-columns=guid'));
  assert.ok(!args.includes('--dry-run'));
});

test('WP-CLI arguments after the wp command pass through unchanged', () => {
  const options = parseArgs(['wp', 'plugin', 'list', '--skip-plugins', '--format=json']);
  assert.deepEqual(options._, ['wp', 'plugin', 'list', '--skip-plugins', '--format=json']);
});

test('replacement manifest rejects duplicate sources and control characters', () => {
  assert.throws(() => parseReplacementManifest({ replacements: [
    { from: 'old.example', to: 'one.ddev.site' },
    { from: 'old.example', to: 'two.ddev.site' },
  ] }, 'manifest.json'), /duplicates/);
  assert.throws(() => parseReplacementManifest({ replacements: [
    { from: 'old\nexample', to: 'new.ddev.site' },
  ] }, 'manifest.json'), /line breaks/);
});
