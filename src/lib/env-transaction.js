'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseEnv(text = '') {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return { text: '', values: {} };
  const text = fs.readFileSync(filePath, 'utf8');
  return { text, values: parseEnv(text) };
}

function mergeEnvText(text, updates) {
  const newline = String(text).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text).split(/\r?\n/);
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=).*/);
    if (!match || !Object.prototype.hasOwnProperty.call(updates, match[2])) continue;
    lines[index] = `${match[1]}${match[2]}=${String(updates[match[2]])}`;
    seen.add(match[2]);
  }
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) lines.push(`${key}=${String(value)}`);
  let result = lines.join(newline);
  if (!result.endsWith(newline)) result += newline;
  return result;
}

function writeAtomic(filePath, text) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.renameSync(temporary, filePath);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(error.code) || attempt === 4) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
      }
    }
    if (lastError) throw lastError;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function commitEnv(filePath, text) {
  writeAtomic(filePath, text);
  return readEnv(filePath);
}

module.exports = { commitEnv, mergeEnvText, parseEnv, readEnv, writeAtomic };
