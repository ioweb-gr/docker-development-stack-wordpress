# IOWEB WordPress stack

This repository is the reusable WordPress integration source for the IOWEB
bootstrap. It is a native DDEV adapter, not a replacement runtime.

## Boundaries

- DDEV owns the WordPress PHP/Nginx lifecycle.
- Commons owns the allocated MariaDB and other shared stateful services.
- This repository must never declare or start a project-local MariaDB,
  Redis, search, Mailpit, or proxy service.
- Consumer credentials, domains, dumps, and WordPress application data remain
  in the consuming checkout.
- Commands must be explicit. Do not start cron, queues, mail delivery, or
  external synchronization automatically.

## Consumer contract

The umbrella bootstrap installs this repository as `docker/wordpress` and
invokes `src/cli.js` from the consumer root. The runtime renderer writes only
ignored generated files under `.ddev/.runtime` and `.ddev/nginx` and uses the
Commons `IOWEB_DDEV_DATABASE_*` environment keys. It preserves the tracked
`wp-config.php` as the source for all non-database settings.

The consumer-owned replacement, table-exclusion, and post-import manifests are
consumed by the umbrella-generated `ddev ioweb-import` command. WordPress
replacement pairs are applied afterward through WP-CLI's precise,
serialized-aware `search-replace`. Never add a `sed` replacement stage for
WordPress SQL, and never import a consumer dump into this repository.

The WordPress stack no longer publishes import, restore, or search-replace
wrappers under `bin/`; those operations belong to the shared DDEV pipeline.
The remaining `wp` wrapper executes only when called from the consumer
checkout and must not start DDEV, run cron, enable mail delivery, or schedule
background work implicitly.

Benchmark and audit commands are bounded, read-only diagnostics. They must not
mutate the WordPress database or trigger scheduled work.
