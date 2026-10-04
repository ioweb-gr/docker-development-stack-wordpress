'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseEnv } = require('../src/lib/env-transaction');
const { ensureTestAdminEnv } = require('../src/lib/test-admin');
const { provisionTestAdmin } = require('../src/cli');

test('WordPress test-admin credentials are generated once in the consumer env file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ioweb-wordpress-test-admin-'));
  const envFile = path.join(root, 'docker', '.env.local');
  try {
    const first = ensureTestAdminEnv(envFile, () => Buffer.alloc(18, 0xab));
    const firstText = fs.readFileSync(envFile, 'utf8');
    const second = ensureTestAdminEnv(envFile, () => Buffer.alloc(18, 0xcd));
    assert.equal(second.values.IOWEB_TEST_ADMIN_PASSWORD, first.values.IOWEB_TEST_ADMIN_PASSWORD);
    assert.equal(fs.readFileSync(envFile, 'utf8'), firstText);
    assert.equal(parseEnv(firstText).IOWEB_TEST_ADMIN_USERNAME, 'ioweb-test-admin');
    assert.match(first.values.IOWEB_TEST_ADMIN_PASSWORD, /^IowebTest-[a-f0-9]+!$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WordPress test-admin provisioning creates an administrator without requiring a live DDEV in unit tests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ioweb-wordpress-test-admin-'));
  const calls = [];
  try {
    const result = provisionTestAdmin({ projectRoot: root, quiet: true }, {
      executeDdevWp: (_root, args) => {
        calls.push(args);
        if (args.includes('core')) return { status: 0, stdout: '', stderr: '' };
        if (args.includes('user') && args.includes('get')) return { status: 1, stdout: '', stderr: 'not found' };
        return { status: 0, stdout: '1\n', stderr: '' };
      },
    });
    assert.equal(result.status, 'created');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].slice(0, 5), ['--skip-plugins', '--skip-themes', 'core', 'is-installed']);
    assert.ok(calls[2].includes('user'));
    assert.ok(calls[2].includes('--role=administrator'));
    assert.ok(calls[2].some((argument) => argument.startsWith('--user_pass=IowebTest-')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
