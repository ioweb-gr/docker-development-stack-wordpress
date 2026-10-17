'use strict';

const DEFAULT_PHP_MEMORY_LIMITS = Object.freeze({ cli: '8G', fpm: '2G' });
const MEMORY_LIMIT_PATTERN = /^[1-9][0-9]*[KMG]$/i;
const PHP_MEMORY_HOOK_MARKER = '# ioweb-managed: docker-bootstrap WordPress PHP memory v1';
const PHP_FPM_PROBE_MARKER = '<?php // ioweb-managed: docker-bootstrap WordPress FPM memory probe v1';

function invalid(name) {
  const error = new Error(`${name}_INVALID`);
  error.code = `${name}_INVALID`;
  return error;
}

function normalizePhpMemoryLimit(value, name) {
  const normalized = String(value).trim().toUpperCase();
  if (!MEMORY_LIMIT_PATTERN.test(normalized)) throw invalid(name);
  return normalized;
}

function resolvePhpMemoryLimits(values = {}, options = {}) {
  const cli = options.phpCliMemoryLimit !== undefined
    ? options.phpCliMemoryLimit
    : Object.prototype.hasOwnProperty.call(values, 'IOWEB_PHP_CLI_MEMORY_LIMIT')
      ? values.IOWEB_PHP_CLI_MEMORY_LIMIT
      : DEFAULT_PHP_MEMORY_LIMITS.cli;
  const fpm = options.phpFpmMemoryLimit !== undefined
    ? options.phpFpmMemoryLimit
    : Object.prototype.hasOwnProperty.call(values, 'IOWEB_PHP_FPM_MEMORY_LIMIT')
      ? values.IOWEB_PHP_FPM_MEMORY_LIMIT
      : DEFAULT_PHP_MEMORY_LIMITS.fpm;
  return {
    cli: normalizePhpMemoryLimit(cli, 'IOWEB_PHP_CLI_MEMORY_LIMIT'),
    fpm: normalizePhpMemoryLimit(fpm, 'IOWEB_PHP_FPM_MEMORY_LIMIT'),
  };
}

function renderPhpMemoryHook() {
  return [
    '#!/bin/sh',
    PHP_MEMORY_HOOK_MARKER,
    '# Values are read from the consumer-local file without printing them.',
    '# Later consumer PHP INI files remain authoritative for explicit overrides.',
    'set -eu',
    '',
    'memory_env_file=/var/www/html/docker/.env.local',
    'read_memory_selector() {',
    '    selector="$1"',
    '    if [ -f "${memory_env_file}" ]; then',
    '        raw="$(awk -v key="${selector}" \'$0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" { sub(/^[[:space:]]*(export[[:space:]]+)?[^=]+=[[:space:]]*/, ""); print; found=1; exit } END { if (!found) exit 1 }\' "${memory_env_file}" 2>/dev/null)" || raw=""',
    '        if [ -n "${raw}" ] || grep -Eq "^[[:space:]]*(export[[:space:]]+)?${selector}[[:space:]]*=" "${memory_env_file}"; then',
    "            printf \"%s\" \"${raw}\" | sed -e \"s/^[[:space:]]*//\" -e \"s/[[:space:]]*$//\" -e \"s/^'//\" -e \"s/'$//\"",
    '            return 0',
    '        fi',
    '    fi',
    '    if printenv "${selector}" >/dev/null 2>&1; then printenv "${selector}"; return 0; fi',
    '    return 1',
    '}',
    'if cli_memory="$(read_memory_selector IOWEB_PHP_CLI_MEMORY_LIMIT)"; then :; else cli_memory=8G; fi',
    'if fpm_memory="$(read_memory_selector IOWEB_PHP_FPM_MEMORY_LIMIT)"; then :; else fpm_memory=2G; fi',
    'cli_memory="$(printf "%s" "${cli_memory}" | tr "[:lower:]" "[:upper:]")"',
    'fpm_memory="$(printf "%s" "${fpm_memory}" | tr "[:lower:]" "[:upper:]")"',
    'if ! printf "%s" "${cli_memory}" | grep -Eq "^[1-9][0-9]*[KMG]$"; then echo IOWEB_PHP_CLI_MEMORY_LIMIT_INVALID >&2; exit 1; fi',
    'if ! printf "%s" "${fpm_memory}" | grep -Eq "^[1-9][0-9]*[KMG]$"; then echo IOWEB_PHP_FPM_MEMORY_LIMIT_INVALID >&2; exit 1; fi',
    'php_version="${DDEV_PHP_VERSION:-$(php -r \'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;\')}"',
    'cli_ini="/etc/php/${php_version}/cli/conf.d/40-ioweb-memory.ini"',
    'fpm_ini="/etc/php/${php_version}/fpm/conf.d/40-ioweb-memory.ini"',
    'for target in "${cli_ini}" "${fpm_ini}"; do',
    '    if [ -L "${target}" ] || { [ -e "${target}" ] && ! grep -q "ioweb-managed: docker-bootstrap WordPress PHP memory v1" "${target}"; }; then echo PHP_MEMORY_MANAGED_FILE_CONFLICT >&2; exit 1; fi',
    'done',
    'memory_tmp="$(mktemp -d /tmp/ioweb-php-memory.XXXXXX)"',
    'trap \'rm -rf "${memory_tmp}"\' EXIT',
    'printf "%s\\n" "; ioweb-managed: docker-bootstrap WordPress PHP memory v1" "memory_limit = ${cli_memory}" > "${memory_tmp}/cli.ini"',
    'printf "%s\\n" "; ioweb-managed: docker-bootstrap WordPress PHP memory v1" "memory_limit = ${fpm_memory}" > "${memory_tmp}/fpm.ini"',
    'sudo mkdir -p "$(dirname "${cli_ini}")" "$(dirname "${fpm_ini}")"',
    'if ! cmp -s "${memory_tmp}/cli.ini" "${cli_ini}" 2>/dev/null; then sudo install -m 0644 "${memory_tmp}/cli.ini" "${cli_ini}"; fi',
    'if ! cmp -s "${memory_tmp}/fpm.ini" "${fpm_ini}" 2>/dev/null; then sudo install -m 0644 "${memory_tmp}/fpm.ini" "${fpm_ini}"; fi',
    '',
  ].join('\n');
}

function renderFpmProbe() {
  return `${PHP_FPM_PROBE_MARKER}
ini_set('display_errors', '0');
error_reporting(0);
$file = '/tmp/ioweb-fpm-memory-' . bin2hex(random_bytes(8)) . '.php';
$code = '<?php echo json_encode(["sapi"=>PHP_SAPI,"memory_limit"=>ini_get("memory_limit"),"php_version"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION]);';
file_put_contents($file, $code);
function frame($type, $body) { return pack('CCnnCC', 1, $type, 1, strlen($body), 0, 0) . $body; }
function readFrame($socket) { $header = fread($socket, 8); if ($header === false || strlen($header) !== 8) throw new RuntimeException('FPM_PROBE_TRANSPORT_FAILED'); $parts = unpack('Cversion/Ctype/nid/nlength/Cpadding/Creserved', $header); $body = $parts['length'] ? fread($socket, $parts['length']) : ''; if ($parts['length'] && ($body === false || strlen($body) !== $parts['length'])) throw new RuntimeException('FPM_PROBE_TRANSPORT_FAILED'); if ($parts['padding']) fread($socket, $parts['padding']); return [$parts, $body]; }
$params = ['SCRIPT_FILENAME'=>$file,'SCRIPT_NAME'=>'/ioweb-memory-probe.php','REQUEST_METHOD'=>'GET','SERVER_PROTOCOL'=>'HTTP/1.1','GATEWAY_INTERFACE'=>'CGI/1.1','SERVER_NAME'=>'localhost','SERVER_PORT'=>'0','REMOTE_ADDR'=>'127.0.0.1'];
$body = ''; foreach ($params as $key=>$value) $body .= chr(strlen($key)).chr(strlen($value)).$key.$value;
$wire = frame(1, pack('nCxxxxx', 1, 0)) . frame(4, $body) . frame(4, '') . frame(5, '');
$sockets = array_merge(['/run/php/php-fpm.sock', '/var/run/php/php-fpm.sock'], glob('/run/php/*.sock') ?: []);
$socket = null; foreach (array_unique($sockets) as $candidate) { $socket = @stream_socket_client('unix://' . $candidate, $errno, $error, 2); if ($socket) break; }
try { if (!$socket) throw new RuntimeException('FPM_SOCKET_UNAVAILABLE'); while ($wire !== '') { $written = fwrite($socket, $wire); if (!$written) throw new RuntimeException('FPM_PROBE_TRANSPORT_FAILED'); $wire = substr($wire, $written); } $output = ''; do { [$header, $data] = readFrame($socket); if ($header['type'] === 6) $output .= $data; } while ($header['type'] !== 3); $parts = preg_split('/\r?\n\r?\n/', $output, 2); $result = json_decode($parts[1] ?? '', true); if (!is_array($result) || ($result['sapi'] ?? '') !== 'fpm-fcgi') throw new RuntimeException('FPM_SAPI_NOT_VERIFIED'); echo json_encode($result) . "\n"; } catch (Throwable $error) { fwrite(STDERR, preg_match('/^FPM_[A-Z_]+$/', $error->getMessage()) ? $error->getMessage() : 'FPM_PROBE_FAILED'); exit(1); } finally { if (is_resource($socket)) fclose($socket); @unlink($file); }
`;
}

module.exports = { DEFAULT_PHP_MEMORY_LIMITS, MEMORY_LIMIT_PATTERN, normalizePhpMemoryLimit, resolvePhpMemoryLimits, renderPhpMemoryHook, renderFpmProbe, PHP_MEMORY_HOOK_MARKER };
