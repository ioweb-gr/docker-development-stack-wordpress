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
ignored files under `.ddev/.runtime` and uses the Commons
`IOWEB_DDEV_DATABASE_*` environment keys. It preserves the tracked
`wp-config.php` as the source for all non-database settings.

Benchmark and audit commands are bounded, read-only diagnostics. They must not
mutate the WordPress database or trigger scheduled work.
