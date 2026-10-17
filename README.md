# IOWEB WordPress development stack

This is the project-neutral WordPress integration used by `docker-bootstrap`.
WordPress runs in the consumer's native DDEV web container. The stack does not
provide a standalone Compose runtime and does not create a local database.

## Database ownership

The generated DDEV configuration omits the local `db` container. The consumer
web container joins the external `ioweb-commons-shared-services` network and
uses the current Commons allocation:

```text
IOWEB_DDEV_DATABASE_HOST
IOWEB_DDEV_DATABASE_PORT
IOWEB_DDEV_DATABASE_NAME
IOWEB_DDEV_DATABASE_USER
IOWEB_DDEV_DATABASE_PASSWORD
```

For an existing standard `wp-config.php`, the renderer creates an ignored
`.ddev/.runtime/wp-config.php` overlay and mounts it at the normal WordPress
config path. Only `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `DB_HOST` are
redirected to the Commons environment. The tracked application configuration
and its non-database settings are not overwritten.

## Automated test administrator

Bootstrap writes the consumer-local `docker/.env.local` with these values,
preserving existing values and generating a password once:

```dotenv
IOWEB_TEST_ADMIN_USERNAME=ioweb-test-admin
IOWEB_TEST_ADMIN_PASSWORD=<generated local password>
IOWEB_TEST_ADMIN_EMAIL=ioweb-test-admin@example.invalid
IOWEB_TEST_ADMIN_FIRST_NAME=IOWEB
IOWEB_TEST_ADMIN_LAST_NAME=Test Admin
```

After DDEV starts, bootstrap creates or updates this WordPress user with the
administrator role. A database import provisions it again after the import
and post-import SQL complete. If WordPress is not installed yet, only the
credentials are written and provisioning is deferred. To run it manually:

```powershell
node docker/wordpress/src/cli.js provision-test-admin --project-root .
```

Keep the consumer env file private; these credentials are for local automated
testing only.

## Dump import and domain replacement

The consumer owns the dump and replacement, table-exclusion, and post-import
SQL manifests. Use the umbrella-generated shared pipeline for every restore:

Initialize the replacement manifest once after the stack has been installed:

```powershell
node docker/wordpress/src/cli.js init-replacements
```

Edit `docker/import-replacements.local.json` with ordered original-domain and
target-URL pairs, then run the shared restore:

```powershell
ddev ioweb-import --dump docker/imports/site.sql.gz
```

It validates all inputs, clears only the allocated Commons schema by default,
streams the SQL import, and applies WordPress replacements afterward through
WP-CLI so serialized values remain valid. Use `--dry-run` to validate all
files without changing the database, or `--no-reset` for an additive import.
Set `include_guid` to `true` in the replacement manifest or pass
`--include-guid` when GUID values must also change. Do not use `sed` for
WordPress database replacement.

Run `docker-bootstrap --install-skills` once from the consumer root to link the
live umbrella and stack skills into `.agents/skills`; `docker-bootstrap
--self-update` refreshes those links after updating the umbrella and its
submodules.

Use the native DDEV runtime directly for arbitrary WP-CLI operations:

```powershell
.\docker\wordpress\bin\wp.ps1 plugin list
ddev wp option get home
```

Run the bootstrap from the consumer root:

```powershell
docker-bootstrap --project-type wordpress
ddev start
ddev describe
```

Composer-based consumers can install their application dependencies with
`ddev composer install`; the generated runtime keeps `vendor/` in a
Docker-managed volume so installation remains writable on Windows Docker
Desktop as well as Linux hosts.

The authorized Commons provisioner is invoked by the umbrella wizard when the
consumer handoff is missing. Do not copy Commons passwords into this repository
or commit the consumer-local handoff.

## Missing image fallback

The runtime renderer also creates the managed
`.ddev/nginx/10-ioweb-wordpress-missing-image.conf` include. Existing image
files are served normally; missing image URLs receive a cacheable 1920x1080
neutral SVG instead of being sent through the WordPress front controller.
The file is regenerated idempotently by `docker-bootstrap` or by running:

```powershell
node docker/wordpress/src/cli.js render-runtime --project-root .
```

The same renderer creates `.ddev/php/90-ioweb-fpm-performance.ini` plus a
managed SAPI-specific startup hook. After a `ddev restart`, CLI/WP-CLI and
Composer use `memory_limit=8G`, while FastCGI uses `memory_limit=2G`. These are
per-process/request ceilings, not reserved RAM. Set independent project-local
overrides in `docker/.env.local`, for example:

```dotenv
IOWEB_PHP_CLI_MEMORY_LIMIT=12G
IOWEB_PHP_FPM_MEMORY_LIMIT=3G
```

Malformed or unlimited values fail closed with a diagnostic code. The runtime
audit reports the CLI `ini_get()` result and a separate authenticated-free
FastCGI probe; consumer-owned PHP INI files loaded later remain authoritative.

## Performance audit

The benchmark is an explicit, bounded HTTP diagnostic. It makes no database
changes and does not run WordPress cron:

```powershell
node docker/wordpress/src/cli.js benchmark `
  --project-root . `
  --url https://my-project.ddev.site/ `
  --requests 10 `
  --concurrency 2
```

On Windows use the wrapper when preferred:

```powershell
.\docker\wordpress\bin\benchmark.ps1 --url https://my-project.ddev.site/ --requests 10 --concurrency 2
```

The runtime audit combines the bounded HTTP benchmark with PHP runtime facts:

```powershell
node docker/wordpress/src/cli.js audit --project-root . --url https://my-project.ddev.site/
```

Use `--output .ddev/.runtime/benchmarks/result.json` to retain a local JSON
report. Requests are capped to prevent accidentally turning this tool into a
load-testing runner.

## Debugging

Native DDEV controls Xdebug:

```powershell
ddev xdebug on
ddev xdebug off
ddev ioweb-profiler status
```

The stack never enables profiling, scheduling, mail delivery, or background
workers automatically.
