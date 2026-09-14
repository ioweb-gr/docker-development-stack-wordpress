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

## Dump import and domain replacement

The consumer owns the dump and replacement, table-exclusion, and post-import
SQL manifests. Use the umbrella-generated shared pipeline for every restore:

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

The same renderer creates `.ddev/php/90-ioweb-fpm-performance.ini`. After a
`ddev restart`, DDEV applies its managed PHP policy to FPM and CLI: timestamp
validation stays enabled with a 120-second revalidation interval and the
realpath cache is 32M.

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
