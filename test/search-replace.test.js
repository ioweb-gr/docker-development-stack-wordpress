const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildSearchReplaceArguments,
  parseReplacementManifest,
  parseArgs,
  renderRuntime,
} = require('../src/cli');

test('WordPress runtime renderer creates an idempotent full-HD missing-image fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ioweb-wordpress-'));
  try {
    const first = renderRuntime(root, { quiet: true });
    assert.equal(first.missing, true);
    const destination = path.join(root, '.ddev', 'nginx', '10-ioweb-wordpress-missing-image.conf');
    const content = fs.readFileSync(destination, 'utf8');
    assert.match(content, /ioweb-managed: docker-bootstrap WordPress missing image fallback v1/);
    assert.match(content, /try_files \$uri @ioweb_wordpress_missing_image/);
    assert.match(content, /width="1920" height="1080" viewBox="0 0 1920 1080"/);
    assert.match(content, /default_type image\/svg\+xml/);

    const second = renderRuntime(root, { quiet: true });
    assert.equal(second.missing, true);
    assert.equal(fs.readFileSync(destination, 'utf8'), content);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WordPress runtime config is syntactically valid PHP', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ioweb-wordpress-'));
  try {
    fs.writeFileSync(path.join(root, 'wp-config.php'), `<?php
define('DB_NAME', 'placeholder');
define('DB_USER', 'placeholder');
define('DB_PASSWORD', 'placeholder');
define('DB_HOST', 'localhost');
`, 'utf8');
    const result = renderRuntime(root, { quiet: true });
    const runtime = fs.readFileSync(result.runtime, 'utf8');
    assert.match(runtime, /function ioweb_ddev_wordpress_database_host\(\) \{[\s\S]*?return \$port[\s\S]*?;\n\}/);

    const lint = spawnSync('php', ['-l', result.runtime], { encoding: 'utf8' });
    if (lint.error?.code === 'ENOENT') {
      t.skip('PHP is not installed on the test host; structural PHP assertions still ran');
      return;
    }
    assert.equal(lint.status, 0, `${lint.stdout}\n${lint.stderr}`);
    assert.match(`${lint.stdout}\n${lint.stderr}`, /No syntax errors detected/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows wrappers resolve the consumer root from the submodule bin directory', () => {
  const bin = path.join(__dirname, '..', 'bin');
  const wrappers = ['import.ps1', 'restore.ps1', 'search-replace.ps1', 'wp.ps1'];
  for (const wrapper of wrappers) {
    const source = fs.readFileSync(path.join(bin, wrapper), 'utf8');
    assert.match(source, /Join-Path \$PSScriptRoot ['"]\.\.\\\.\.\\\.\.['"]/);
    assert.doesNotMatch(source, /Join-Path \$PSScriptRoot ['"]\.\.\\\.\.['"]/);
  }
  const simulatedBin = path.join('consumer', 'docker', 'wordpress', 'bin');
  assert.equal(path.resolve(simulatedBin, '..', '..', '..'), path.resolve('consumer'));
});

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
