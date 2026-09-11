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

Run the bootstrap from the consumer root:

```powershell
docker-bootstrap --project-type wordpress
ddev start
ddev describe
```

The authorized Commons provisioner is invoked by the umbrella wizard when the
consumer handoff is missing. Do not copy Commons passwords into this repository
or commit the consumer-local handoff.

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
