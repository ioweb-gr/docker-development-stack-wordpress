#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const childProcess = require('node:child_process');

const RUNTIME_MARKER = '// ioweb-managed: docker-bootstrap WordPress Commons database overlay v1';
const COMPOSE_MARKER = '# ioweb-managed: docker-bootstrap WordPress Commons runtime mounts v1';
const MISSING_IMAGE_NGINX_MARKER = '# ioweb-managed: docker-bootstrap WordPress missing image fallback v1';
const PHP_PERFORMANCE_MARKER = '; ioweb-managed: docker-bootstrap WordPress FPM performance v1';
const MISSING_IMAGE_NGINX_FILE = '10-ioweb-wordpress-missing-image.conf';
const PHP_PERFORMANCE_FILE = '90-ioweb-fpm-performance.ini';
const DEFAULT_DUMP_FILE = 'docker/imports/dump.sql.gz';
const DEFAULT_REPLACEMENTS_MANIFEST = 'docker/import-replacements.local.json';

function usage() {
  return [
    'Usage: node src/cli.js <command> [options]',
    '',
    'Commands:',
    '  render-runtime  Generate the ignored Commons-backed wp-config overlay',
    '  init-replacements Create a consumer-owned replacement manifest template',
    '  import          Import an SQL or SQL.GZ dump into the Commons database',
    '  search-replace  Dry-run or apply serialized-safe URL replacements with WP-CLI',
    '  restore         Import a dump, then apply the replacement manifest with WP-CLI',
    '  wp              Run arbitrary WP-CLI arguments in the DDEV web container',
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
    '  --dump FILE           SQL or SQL.GZ dump relative to the project root',
    '  --manifest FILE       Replacement manifest relative to the project root',
    '  --dry-run             Preview WP-CLI replacements without changing the database',
    '  --apply               Apply WP-CLI replacements (search-replace defaults to dry-run)',
    '  --include-guid        Include the WordPress guid column in replacements',
    '  --confirm             Confirm an import or replacement without an interactive prompt',
    '  --insecure             Allow invalid TLS for non-local targets',
    '  --force               Replace an unmanaged generated runtime file',
    '  --quiet               Suppress human-readable output',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { _: [] };
  const valueOptions = new Set(['project-root', 'url', 'requests', 'concurrency', 'timeout-ms', 'output', 'dump', 'manifest']);
  let passThrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passThrough || (options._[0] === 'wp' && token.startsWith('--'))) {
      options._.push(token);
      continue;
    }
    if (token === '--') {
      passThrough = true;
      continue;
    }
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
    if (!['apply', 'confirm', 'dry-run', 'force', 'include-guid', 'insecure', 'quiet'].includes(key)) throw new Error(`Unknown option: --${key}`);
    options[key] = true;
  }
  return options;
}

function projectRoot(options) {
  const root = path.resolve(options['project-root'] || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  return root;
}

function resolveProjectFile(root, requested, fallback, label, mustExist = true) {
  const relative = String(requested || fallback).trim();
  if (!relative) throw new Error(`${label} path is required.`);
  const hostPath = path.resolve(root, relative);
  const withinRoot = path.relative(root, hostPath);
  if (!withinRoot || withinRoot.startsWith('..') || path.isAbsolute(withinRoot)) {
    throw new Error(`${label} must be inside the consumer project root: ${relative}`);
  }
  if (mustExist && (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isFile())) {
    throw new Error(`${label} does not exist: ${path.relative(root, hostPath)}`);
  }
  return {
    hostPath,
    relativePath: withinRoot.replaceAll('\\', '/'),
    containerPath: `/var/www/html/${withinRoot.replaceAll('\\', '/')}`,
  };
}

function parseReplacementManifest(manifest, sourcePath) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`WordPress replacement manifest must contain an object: ${sourcePath}`);
  }
  if (!Array.isArray(manifest.replacements)) {
    throw new Error(`WordPress replacement manifest must contain a replacements array: ${sourcePath}`);
  }
  if (manifest.include_guid !== undefined && typeof manifest.include_guid !== 'boolean') {
    throw new Error(`WordPress replacement manifest include_guid must be boolean: ${sourcePath}`);
  }
  const seen = new Set();
  const replacements = manifest.replacements.map((replacement, index) => {
    if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) {
      throw new Error(`replacements[${index}] must be an object: ${sourcePath}`);
    }
    const from = String(replacement.from || '').trim();
    const to = String(replacement.to || '').trim();
    if (!from || !to) throw new Error(`replacements[${index}] requires non-empty from and to values: ${sourcePath}`);
    if (from === to) throw new Error(`replacements[${index}] from and to must differ: ${sourcePath}`);
    if (/\0|[\r\n]/.test(from) || /\0|[\r\n]/.test(to)) {
      throw new Error(`replacements[${index}] cannot contain line breaks or null bytes: ${sourcePath}`);
    }
    if (seen.has(from)) throw new Error(`replacements[${index}] duplicates from '${from}': ${sourcePath}`);
    seen.add(from);
    return Object.freeze({ from, to });
  });
  return Object.freeze({
    includeGuid: manifest.include_guid === true,
    replacements: Object.freeze(replacements),
  });
}

function readReplacementManifest(root, options = {}, required = true) {
  const requested = options.manifest || process.env.IOWEB_WORDPRESS_REPLACEMENTS_MANIFEST || DEFAULT_REPLACEMENTS_MANIFEST;
  const resolved = resolveProjectFile(root, requested, DEFAULT_REPLACEMENTS_MANIFEST, 'Replacement manifest', false);
  if (!fs.existsSync(resolved.hostPath)) {
    if (!required) return { ...resolved, missing: true, includeGuid: false, replacements: [] };
    throw new Error(`Replacement manifest is missing: ${resolved.relativePath}. Run 'node docker/wordpress/src/cli.js init-replacements' first.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolved.hostPath, 'utf8'));
  } catch (error) {
    throw new Error(`Replacement manifest is not valid JSON: ${resolved.relativePath} (${error.message})`);
  }
  return { ...resolved, missing: false, ...parseReplacementManifest(manifest, resolved.relativePath) };
}

function writeJsonReport(root, output, report) {
  if (!output) return;
  const destination = resolveProjectFile(root, output, output, 'Report output', false);
  fs.mkdirSync(path.dirname(destination.hostPath), { recursive: true });
  fs.writeFileSync(destination.hostPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function confirmOperation(question, options = {}) {
  if (options.confirm) return Promise.resolve(true);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error(`${question} Re-run interactively or pass --confirm.`));
  }
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    input.question(`${question} [y/N] `, (answer) => {
      input.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  }).then((confirmed) => {
    if (!confirmed) throw new Error('Operation cancelled.');
    return true;
  });
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
    '}',
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

function renderMissingImageNginx() {
  return [
    MISSING_IMAGE_NGINX_MARKER,
    '# Existing image files are served normally; missing image requests receive',
    '# a neutral full-HD SVG without entering the WordPress front controller.',
    'location ~* \\.\\.(?:avif|avifs|gif|ico|jpe?g|png|svg|svgz|webp)$ {',
    '    try_files $uri @ioweb_wordpress_missing_image;',
    '}',
    '',
    'location @ioweb_wordpress_missing_image {',
    '    internal;',
    '    types {}',
    '    default_type image/svg+xml;',
    '    add_header Cache-Control "public, max-age=300" always;',
    '    add_header X-Frame-Options "SAMEORIGIN" always;',
    '    return 200 \'<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid meet"><rect width="1920" height="1080" fill="rgb(243,244,246)"/></svg>\';',
    '}',
    '',
  ].join('\n');
}

function renderMissingImageNginxConfig(root, options = {}) {
  const destination = path.join(root, '.ddev', 'nginx', MISSING_IMAGE_NGINX_FILE);
  const rendered = renderMissingImageNginx();
  const existing = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : '';
  if (existing && !existing.includes(MISSING_IMAGE_NGINX_MARKER) && !options.force) {
    throw new Error(`Refusing to overwrite non-managed WordPress missing-image configuration: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!managedTextEqual(existing, rendered)) fs.writeFileSync(destination, rendered, 'utf8');
  return destination;
}

function renderPhpPerformance() {
  return [
    PHP_PERFORMANCE_MARKER,
    '; DDEV copies .ddev/php/*.ini into both the CLI and FPM SAPIs.',
    'opcache.validate_timestamps = 1',
    'opcache.revalidate_freq = 120',
    'realpath_cache_size = 32M',
    'realpath_cache_ttl = 7200',
    '',
  ].join('\n');
}

function renderPhpPerformanceConfig(root, options = {}) {
  const destination = path.join(root, '.ddev', 'php', PHP_PERFORMANCE_FILE);
  const rendered = renderPhpPerformance();
  const existing = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : '';
  if (existing && !existing.includes(PHP_PERFORMANCE_MARKER) && !options.force) {
    throw new Error(`Refusing to overwrite unmanaged WordPress PHP performance configuration: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!managedTextEqual(existing, rendered)) fs.writeFileSync(destination, rendered, 'utf8');
  return destination;
}

function renderRuntime(root, options = {}) {
  const php = renderPhpPerformanceConfig(root, options);
  const missingImage = renderMissingImageNginxConfig(root, options);
  const rendered = renderWordpressRuntimeConfig(root);
  if (!rendered) {
    if (!options.quiet) console.log(`[wordpress] wp-config.php is absent; PHP performance: ${path.relative(root, php)}; missing image fallback: ${path.relative(root, missingImage)}`);
    return { missing: true, php, missingImage };
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
  return { missing: false, runtime: destination, compose: composeDestination, php, missingImage };
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

function runDdevWp(root, wpArguments, options = {}) {
  const result = childProcess.spawnSync(ddevCommand(), ['exec', '-s', 'web', 'wp', ...wpArguments], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || (result.error?.message || ''));
  if (!options.quiet && stdout) process.stdout.write(stdout);
  if (!options.quiet && stderr) process.stderr.write(stderr);
  if (result.error || result.status !== 0) {
    const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
    throw new Error(`DDEV WP-CLI command failed${detail ? `: ${detail}` : '.'}`);
  }
  return Object.freeze({ stdout, stderr });
}

function initReplacements(options) {
  const root = projectRoot(options);
  const destination = resolveProjectFile(root, options.manifest, DEFAULT_REPLACEMENTS_MANIFEST, 'Replacement manifest', false);
  const template = [
    '{',
    '  "schema": "ioweb-wordpress-import-replacements/v1",',
    '  "include_guid": false,',
    '  "replacements": []',
    '}',
    '',
  ].join('\n');
  if (fs.existsSync(destination.hostPath)) {
    const existing = fs.readFileSync(destination.hostPath, 'utf8');
    parseReplacementManifest(JSON.parse(existing), destination.relativePath);
    if (!options.quiet) console.log(`[wordpress] replacement manifest already exists: ${destination.relativePath}`);
    return { created: false, path: destination.relativePath };
  }
  fs.mkdirSync(path.dirname(destination.hostPath), { recursive: true });
  fs.writeFileSync(destination.hostPath, template, 'utf8');
  if (!options.quiet) console.log(`[wordpress] created replacement manifest: ${destination.relativePath}`);
  return { created: true, path: destination.relativePath };
}

function buildSearchReplaceArguments(replacement, manifest, options = {}, dryRun = true) {
  const args = [
    '--skip-plugins',
    '--skip-themes',
    'search-replace',
    replacement.from,
    replacement.to,
    '--all-tables-with-prefix',
    '--precise',
    '--recurse-objects',
  ];
  if (!(manifest.includeGuid || options['include-guid'])) args.push('--skip-columns=guid');
  if (dryRun) args.push('--dry-run');
  return args;
}

async function searchReplace(options, context = {}) {
  const root = context.root || projectRoot(options);
  const manifest = context.manifest || readReplacementManifest(root, options);
  const apply = options.apply === true;
  if (apply && options['dry-run']) throw new Error('Use either --dry-run or --apply, not both.');
  const dryRun = !apply;
  if (manifest.replacements.length === 0) {
    if (!options.quiet) console.log(`[wordpress] no replacements configured in ${manifest.relativePath}`);
    return { schema: 'ioweb-wordpress-search-replace/v1', dry_run: dryRun, replacements: 0, manifest: manifest.relativePath };
  }
  if (apply && !context.confirmed) {
    await confirmOperation(`[wordpress] Apply ${manifest.replacements.length} replacement(s) to the Commons database using ${manifest.relativePath}?`, options);
  }
  const started = performance.now();
  for (const replacement of manifest.replacements) {
    runDdevWp(root, buildSearchReplaceArguments(replacement, manifest, options, dryRun), options);
  }
  const report = {
    schema: 'ioweb-wordpress-search-replace/v1',
    manifest: manifest.relativePath,
    dry_run: dryRun,
    include_guid: manifest.includeGuid || options['include-guid'] === true,
    replacements: manifest.replacements.length,
    duration_ms: Number((performance.now() - started).toFixed(3)),
  };
  writeJsonReport(root, options.output, report);
  if (!options.quiet) {
    console.log(`[wordpress] ${dryRun ? 'previewed' : 'applied'} ${report.replacements} replacement(s) with WP-CLI`);
    if (dryRun) console.log('[wordpress] rerun with --apply to mutate the database');
  }
  return report;
}

async function importDatabase(options, context = {}) {
  const root = context.root || projectRoot(options);
  const dump = context.dump || resolveProjectFile(
    root,
    options.dump || process.env.IOWEB_WORDPRESS_DUMP_FILE,
    DEFAULT_DUMP_FILE,
    'WordPress SQL dump',
  );
  if (!/\.sql(?:\.gz)?$/i.test(dump.relativePath)) {
    throw new Error(`WordPress SQL dump must end in .sql or .sql.gz: ${dump.relativePath}`);
  }
  if (!context.confirmed) {
    await confirmOperation(`[wordpress] Import ${dump.relativePath} into the current Commons database?`, options);
  }
  const started = performance.now();
  runDdevWp(root, [
    '--skip-plugins',
    '--skip-themes',
    'db',
    'import',
    dump.containerPath,
  ], options);
  const report = {
    schema: 'ioweb-wordpress-import/v1',
    dump: dump.relativePath,
    duration_ms: Number((performance.now() - started).toFixed(3)),
  };
  writeJsonReport(root, options.output, report);
  if (!options.quiet) console.log(`[wordpress] imported ${dump.relativePath} through WP-CLI`);
  return report;
}

async function restore(options) {
  const root = projectRoot(options);
  if (options['dry-run']) throw new Error('Use search-replace --dry-run to preview replacements; restore always imports and mutates the database.');
  const dump = resolveProjectFile(
    root,
    options.dump || process.env.IOWEB_WORDPRESS_DUMP_FILE,
    DEFAULT_DUMP_FILE,
    'WordPress SQL dump',
  );
  if (!/\.sql(?:\.gz)?$/i.test(dump.relativePath)) {
    throw new Error(`WordPress SQL dump must end in .sql or .sql.gz: ${dump.relativePath}`);
  }
  const manifest = readReplacementManifest(root, options);
  if (manifest.replacements.length === 0) throw new Error(`Restore requires at least one replacement in ${manifest.relativePath}.`);
  await confirmOperation(`[wordpress] Import ${dump.relativePath}, then apply ${manifest.replacements.length} serialized-safe replacement(s) to the Commons database?`, options);
  const importReport = await importDatabase(options, { root, dump, confirmed: true });
  const replacementReport = await searchReplace({ ...options, apply: true }, { root, manifest, confirmed: true });
  const report = {
    schema: 'ioweb-wordpress-restore/v1',
    import: importReport,
    search_replace: replacementReport,
  };
  writeJsonReport(root, options.output, report);
  return report;
}

function runWp(options) {
  const root = projectRoot(options);
  return runDdevWp(root, options._.slice(1), options);
}

function runtimeAudit(options) {
  const root = projectRoot(options);
  const code = "echo json_encode(['php_version'=>PHP_VERSION,'memory_limit'=>ini_get('memory_limit'),'opcache_enabled'=>(bool)ini_get('opcache.enable'),'opcache_cli_enabled'=>(bool)ini_get('opcache.enable_cli'),'opcache_validate_timestamps'=>(bool)ini_get('opcache.validate_timestamps'),'opcache_revalidate_freq'=>ini_get('opcache.revalidate_freq'),'realpath_cache_size'=>ini_get('realpath_cache_size')]);";
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
  if (command === 'init-replacements') {
    initReplacements(options);
    return 0;
  }
  if (command === 'import') {
    await importDatabase(options);
    return 0;
  }
  if (command === 'search-replace') {
    await searchReplace(options);
    return 0;
  }
  if (command === 'restore') {
    await restore(options);
    return 0;
  }
  if (command === 'wp') {
    runWp(options);
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
  buildSearchReplaceArguments,
  importDatabase,
  initReplacements,
  parseArgs,
  parseReplacementManifest,
  readReplacementManifest,
  renderRuntime,
  renderRuntimeCompose,
  renderPhpPerformance,
  renderPhpPerformanceConfig,
  renderMissingImageNginx,
  renderMissingImageNginxConfig,
  renderWordpressRuntimeConfig,
  restore,
  runtimeAudit,
  searchReplace,
};
