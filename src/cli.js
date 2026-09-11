#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const childProcess = require('node:child_process');

const RUNTIME_MARKER = '// ioweb-managed: docker-bootstrap WordPress Commons database overlay v1';
const COMPOSE_MARKER = '# ioweb-managed: docker-bootstrap WordPress Commons runtime mounts v1';

function usage() {
  return [
    'Usage: node src/cli.js <command> [options]',
    '',
    'Commands:',
    '  render-runtime  Generate the ignored Commons-backed wp-config overlay',
    '  benchmark       Run a bounded HTTP benchmark against the local site',
    '  audit           Report PHP runtime settings and run the HTTP benchmark',
    '',
    'Options:',
    '  --project-root DIR   Consumer root; defaults to the current directory',
    '  --url URL             HTTP target for benchmark/audit',
    '  --requests N          Number of requests, 1-100 (default: 10)',
    '  --concurrency N       Parallel requests, 1-10 (default: 2)',
    '  --timeout-ms N        Per-request timeout (default: 30000)',
    '  --output FILE         Write a JSON report relative to the project root',
    '  --insecure             Allow invalid TLS for non-local targets',
    '  --force               Replace an unmanaged generated runtime file',
    '  --quiet               Suppress human-readable output',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { _: [] };
  const valueOptions = new Set(['project-root', 'url', 'requests', 'concurrency', 'timeout-ms', 'output']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'help') {
      options.help = true;
      continue;
    }
    if (valueOptions.has(key)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
      options[key] = value;
      index += 1;
      continue;
    }
    if (!['force', 'insecure', 'quiet'].includes(key)) throw new Error(`Unknown option: --${key}`);
    options[key] = true;
  }
  return options;
}

function projectRoot(options) {
  const root = path.resolve(options['project-root'] || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  return root;
}

function managedTextEqual(left, right) {
  return String(left).replace(/\r\n/g, '\n').replace(/\s+$/g, '')
    === String(right).replace(/\r\n/g, '\n').replace(/\s+$/g, '');
}

function renderWordpressRuntimeConfig(root) {
  const sourcePath = path.join(root, 'wp-config.php');
  if (!fs.existsSync(sourcePath)) return null;
  const source = fs.readFileSync(sourcePath, 'utf8');
  const replaced = new Set();
  const databaseDefinition = /^([ \t]*)define\s*\(\s*(['"])DB_(NAME|USER|PASSWORD|HOST)\2\s*,[^\r\n]*\)\s*;[^\r\n]*$/gm;
  const rendered = source.replace(databaseDefinition, (line, indent, quote, key) => {
    replaced.add(key);
    const value = key === 'HOST'
      ? 'ioweb_ddev_wordpress_database_host()'
      : `ioweb_ddev_wordpress_env('IOWEB_DDEV_DATABASE_${key}')`;
    return `${indent}define(${quote}DB_${key}${quote}, ${value});`;
  });
  const required = ['NAME', 'USER', 'PASSWORD', 'HOST'];
  const missing = required.filter((key) => !replaced.has(key));
  if (missing.length > 0) {
    throw new Error(`WordPress wp-config.php must contain standard DB_* definitions for Commons DDEV wiring; missing DB_${missing.join(', DB_')}.`);
  }
  const helper = [
    RUNTIME_MARKER,
    'function ioweb_ddev_wordpress_env($key) {',
    '    $value = getenv($key);',
    '    if ($value === false || $value === "") {',
    '        throw new RuntimeException("Missing Commons database environment key: " . $key);',
    '    }',
    '    return $value;',
    '}',
    'function ioweb_ddev_wordpress_database_host() {',
    '    $host = ioweb_ddev_wordpress_env("IOWEB_DDEV_DATABASE_HOST");',
    '    $port = getenv("IOWEB_DDEV_DATABASE_PORT");',
    '    return $port && $port !== "3306" ? $host . ":" . $port : $host;',
    '',
  ].join('\n');
  const phpOpen = rendered.match(/^\uFEFF?<\?php[^\r\n]*(?:\r?\n|$)/);
  if (!phpOpen) throw new Error(`WordPress wp-config.php does not begin with a PHP opening tag: ${sourcePath}`);
  return `${rendered.slice(0, phpOpen[0].length)}${helper}${rendered.slice(phpOpen[0].length)}`;
}

function renderRuntimeCompose(root) {
  const runtime = path.join(root, '.ddev', '.runtime', 'wp-config.php').replace(/\\/g, '/');
  return [
    COMPOSE_MARKER,
    '# The generated file is local runtime state and is never committed.',
    'services:',
    '  web:',
    '    volumes:',
    `      - ${JSON.stringify(`${runtime}:/var/www/html/wp-config.php:ro`)}`,
    '',
  ].join('\n');
}

function renderRuntime(root, options) {
  const rendered = renderWordpressRuntimeConfig(root);
  if (!rendered) {
    if (!options.quiet) console.log('[wordpress] wp-config.php is absent; no runtime overlay was created');
    return { missing: true };
  }
  const destination = path.join(root, '.ddev', '.runtime', 'wp-config.php');
  const existing = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : '';
  if (existing && !existing.includes(RUNTIME_MARKER) && !options.force) {
    throw new Error(`Refusing to overwrite non-managed WordPress runtime config: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!managedTextEqual(existing, rendered)) fs.writeFileSync(destination, rendered, 'utf8');

  const composeDestination = path.join(root, '.ddev', 'docker-compose.ioweb-wordpress-runtime-config.yaml');
  const compose = renderRuntimeCompose(root);
  const existingCompose = fs.existsSync(composeDestination) ? fs.readFileSync(composeDestination, 'utf8') : '';
  if (existingCompose && !existingCompose.includes(COMPOSE_MARKER) && !options.force) {
    throw new Error(`Refusing to overwrite non-managed WordPress runtime compose file: ${composeDestination}`);
  }
  fs.mkdirSync(path.dirname(composeDestination), { recursive: true });
  if (!managedTextEqual(existingCompose, compose)) fs.writeFileSync(composeDestination, compose, 'utf8');
  if (!options.quiet) console.log(`[wordpress] Commons runtime overlay: ${path.relative(root, destination)}`);
  return { missing: false, runtime: destination, compose: composeDestination };
}

function isLocalTarget(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.ddev.site');
}

function integerOption(options, key, fallback, minimum, maximum) {
  const value = options[key] === undefined ? fallback : Number(options[key]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function requestOnce(target, timeoutMs, insecure) {
  const parsed = new URL(target);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Unsupported benchmark URL protocol: ${parsed.protocol}`);
  const transport = parsed.protocol === 'https:' ? https : http;
  const started = performance.now();
  return new Promise((resolve) => {
    const request = transport.request(parsed, {
      method: 'GET',
      headers: { 'User-Agent': 'ioweb-wordpress-benchmark/1' },
      rejectUnauthorized: parsed.protocol !== 'https:' || (isLocalTarget(parsed.hostname) ? false : !insecure),
    }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('end', () => resolve({
        status: response.statusCode || null,
        bytes,
        duration_ms: Number((performance.now() - started).toFixed(3)),
      }));
      response.resume();
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    request.on('error', (error) => resolve({
      status: null,
      bytes: 0,
      duration_ms: Number((performance.now() - started).toFixed(3)),
      error: error.code || error.message,
    }));
    request.end();
  });
}

async function benchmark(options) {
  const root = projectRoot(options);
  const target = options.url;
  if (!target) throw new Error('--url is required for benchmark/audit.');
  const requests = integerOption(options, 'requests', 10, 1, 100);
  const concurrency = integerOption(options, 'concurrency', 2, 1, 10);
  const timeoutMs = integerOption(options, 'timeout-ms', 30000, 100, 120000);
  const results = [];
  while (results.length < requests) {
    const count = Math.min(concurrency, requests - results.length);
    results.push(...await Promise.all(Array.from({ length: count }, () => requestOnce(target, timeoutMs, options.insecure))));
  }
  const durations = results.map((result) => result.duration_ms).sort((a, b) => a - b);
  const successful = results.filter((result) => result.status >= 200 && result.status < 400);
  const statusCounts = {};
  for (const result of results) {
    const key = result.status === null ? 'error' : String(result.status);
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }
  const percentile = (fraction) => durations[Math.min(durations.length - 1, Math.max(0, Math.ceil(durations.length * fraction) - 1))];
  const report = {
    schema: 'ioweb-wordpress-benchmark/v1',
    target,
    requests,
    concurrency,
    timeout_ms: timeoutMs,
    successful: successful.length,
    failed: requests - successful.length,
    status_counts: statusCounts,
    bytes: results.reduce((total, result) => total + result.bytes, 0),
    timings_ms: {
      min: durations[0],
      mean: Number((durations.reduce((total, value) => total + value, 0) / durations.length).toFixed(3)),
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: durations[durations.length - 1],
    },
    errors: results.filter((result) => result.error).map((result) => result.error),
  };
  if (options.output) {
    const output = path.resolve(root, options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (!options.quiet) {
    console.log(`Target: ${report.target}`);
    console.log(`Requests: ${report.requests} (${report.concurrency} concurrent)`);
    console.log(`Successful: ${report.successful}/${report.requests}`);
    console.log(`Latency ms: min ${report.timings_ms.min}, p50 ${report.timings_ms.p50}, p95 ${report.timings_ms.p95}, mean ${report.timings_ms.mean}, max ${report.timings_ms.max}`);
    if (options.output) console.log(`Report: ${path.relative(root, path.resolve(root, options.output))}`);
  }
  return report;
}

function ddevCommand() {
  const candidates = process.platform === 'win32' ? ['ddev.exe', 'ddev.cmd', 'ddev'] : ['ddev'];
  for (const candidate of candidates) {
    const probe = childProcess.spawnSync(candidate, ['version'], { stdio: 'ignore', shell: false });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('DDEV executable is not available on PATH.');
}

function runtimeAudit(options) {
  const root = projectRoot(options);
  const code = "echo json_encode(['php_version'=>PHP_VERSION,'memory_limit'=>ini_get('memory_limit'),'opcache_enabled'=>(bool)ini_get('opcache.enable'),'opcache_cli_enabled'=>(bool)ini_get('opcache.enable_cli'),'opcache_revalidate_freq'=>ini_get('opcache.revalidate_freq')]);";
  const result = childProcess.spawnSync(ddevCommand(), ['exec', '-s', 'web', 'php', '-r', code], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.error || result.status !== 0) throw new Error(`DDEV PHP audit failed${result.stderr ? `: ${result.stderr.trim()}` : '.'}`);
  const match = String(result.stdout || '').match(/\{[^\r\n]*\}\s*$/);
  if (!match) throw new Error('DDEV PHP audit returned no JSON runtime data.');
  return JSON.parse(match[0]);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || options._[0] === undefined) {
    console.log(usage());
    return 0;
  }
  const command = options._[0];
  if (command === 'render-runtime') {
    renderRuntime(projectRoot(options), options);
    return 0;
  }
  if (command === 'benchmark') {
    await benchmark(options);
    return 0;
  }
  if (command === 'audit') {
    const runtime = runtimeAudit(options);
    if (!options.quiet) {
      console.log(`PHP: ${runtime.php_version}`);
      console.log(`OPcache: ${runtime.opcache_enabled ? 'enabled' : 'disabled'} (CLI ${runtime.opcache_cli_enabled ? 'enabled' : 'disabled'}, revalidate ${runtime.opcache_revalidate_freq}s)`);
    }
    await benchmark(options);
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  benchmark,
  parseArgs,
  renderRuntime,
  renderRuntimeCompose,
  renderWordpressRuntimeConfig,
  runtimeAudit,
};
