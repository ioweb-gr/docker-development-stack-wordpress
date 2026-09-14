---
name: ioweb-docker-wordpress
description: Operate the native-DDEV WordPress adapter with Commons MariaDB and the shared database import pipeline.
---

# IOWEB WordPress stack

Use this skill from a WordPress consumer root after reading its `AGENTS.md`.
WordPress runs in native DDEV and uses the allocated Commons database; the
stack does not provide a standalone Compose runtime or project-local stateful
services.

Use the umbrella-generated command for every database restore:

Initialize the consumer-owned replacement manifest once:

```powershell
node docker/wordpress/src/cli.js init-replacements
```

```powershell
ddev ioweb-import --dump docker/imports/site.sql.gz
ddev ioweb-import --dry-run
```

The shared pipeline validates `.sql`/`.sql.gz` dumps, clears only the allocated
consumer schema by default, applies optional table exclusions, performs
WordPress replacements afterward through WP-CLI to preserve serialized values,
and executes optional post-import SQL. Use `--no-reset` only for an additive
import and `--confirm` for non-interactive mutation. Dumps and manifests stay
in the consumer checkout.

The old WordPress `bin/import`, `bin/restore`, and `bin/search-replace`
wrappers are removed so they cannot be selected instead of the shared command.
Use `docker/wordpress/bin/wp.*` for explicit WP-CLI commands and the remaining
benchmark or audit wrappers for bounded diagnostics.

Run `docker-bootstrap --install-skills` from the consumer root to install live
links to the umbrella and stack skills. `docker-bootstrap --self-update`
updates the source repositories and refreshes those links automatically.
