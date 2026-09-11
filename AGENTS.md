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

The consumer-owned `docker/import-replacements.local.json` uses ordered
`from`/`to` pairs. `import` runs `wp db import` against the allocated Commons
database; `search-replace` then runs WP-CLI's precise, serialized-aware
`search-replace` across tables with the WordPress prefix. `restore` is the
explicit combined operation. Never add a `sed` replacement stage for
WordPress SQL, and never import a consumer dump into this repository.

The `wp`, `import`, `search-replace`, and `restore` wrappers execute only when
called from the consumer checkout. They must not start DDEV, run cron, enable
mail delivery, or schedule background work implicitly.

Benchmark and audit commands are bounded, read-only diagnostics. They must not
mutate the WordPress database or trigger scheduled work.
