'use strict';

const { randomBytes } = require('node:crypto');
const { commitEnv, mergeEnvText, readEnv } = require('./env-transaction');

const TEST_ADMIN_KEYS = Object.freeze([
  'IOWEB_TEST_ADMIN_USERNAME',
  'IOWEB_TEST_ADMIN_PASSWORD',
  'IOWEB_TEST_ADMIN_EMAIL',
  'IOWEB_TEST_ADMIN_FIRST_NAME',
  'IOWEB_TEST_ADMIN_LAST_NAME',
]);

function requireSingleLine(value, key) {
  const text = String(value ?? '');
  if (!text || /[\r\n]/.test(text)) throw new Error(`${key} must be a non-empty single-line value.`);
  return text;
}

function buildTestAdminValues(values = {}, bytes = randomBytes) {
  const source = values || {};
  const generatedPassword = `IowebTest-${bytes(18).toString('hex')}!`;
  const result = {
    IOWEB_TEST_ADMIN_USERNAME: source.IOWEB_TEST_ADMIN_USERNAME || 'ioweb-test-admin',
    IOWEB_TEST_ADMIN_PASSWORD: source.IOWEB_TEST_ADMIN_PASSWORD || generatedPassword,
    IOWEB_TEST_ADMIN_EMAIL: source.IOWEB_TEST_ADMIN_EMAIL || 'ioweb-test-admin@example.invalid',
    IOWEB_TEST_ADMIN_FIRST_NAME: source.IOWEB_TEST_ADMIN_FIRST_NAME || 'IOWEB',
    IOWEB_TEST_ADMIN_LAST_NAME: source.IOWEB_TEST_ADMIN_LAST_NAME || 'Test Admin',
  };
  for (const key of TEST_ADMIN_KEYS) result[key] = requireSingleLine(result[key], key);
  if (!/^[A-Za-z0-9._-]+$/.test(result.IOWEB_TEST_ADMIN_USERNAME)) {
    throw new Error('IOWEB_TEST_ADMIN_USERNAME may contain only letters, numbers, dots, underscores, and hyphens.');
  }
  if (!/^\S+@\S+\.\S+$/.test(result.IOWEB_TEST_ADMIN_EMAIL)) {
    throw new Error('IOWEB_TEST_ADMIN_EMAIL must be a valid email address.');
  }
  return result;
}

function ensureTestAdminEnv(envFile, bytes = randomBytes) {
  const current = readEnv(envFile);
  const values = buildTestAdminValues(current.values, bytes);
  const stagedText = mergeEnvText(current.text, values);
  const readback = stagedText === current.text ? current : commitEnv(envFile, stagedText);
  return { values, envFile, changed: readback.text !== current.text };
}

module.exports = { TEST_ADMIN_KEYS, buildTestAdminValues, ensureTestAdminEnv };
