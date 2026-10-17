# Running the backend on a server

Scripts to run the Lemniscate services against Robinhood Chain mainnet (chain id 4663) on one small Ubuntu server
(written for a Cherry Servers VPS: Ubuntu 26.04 64-bit, 4 GB RAM or more, root SSH login with a key). Everything runs on
the one machine: Postgres with TimescaleDB, the Bun services and the Python vol engine under systemd, and Caddy in front
for HTTPS. Nothing here is run by the test suites; `bash -n` and shellcheck are the checks.

| File | What it is |
| --- | --- |
| `provision.sh` | Run once as root on the server (safe to run again): user, packages, Postgres + TimescaleDB, firewall, fail2ban, automatic security updates, swap, Bun, cast, Caddy, systemd units, backup timer |
| `deploy.sh` | Run from your own machine: ships a commit, installs dependencies, migrates the database, restarts the services one by one, checks each, rolls back on a failure |
| `backup.sh` | Nightly `pg_dump` into `/var/backups/lemniscate`, 14 days kept (installed as `/usr/local/sbin/lemniscate-backup`) |
| `env.example` | Every variable the services read on mainnet; becomes `/etc/lemniscate/lemniscate.env` |
| `Caddyfile` | HTTPS reverse proxy template: the API, and the MCP server if you give it a domain |
| `systemd/` | One unit per service, `lemniscate.target` grouping them, the migration unit, the backup timer |

## Layout on the server

| Path | |
| --- | --- |
| `/opt/lemniscate/releases/<time>-<commit>` | One folder per deploy (the last 5 are kept) |
| `/opt/lemniscate/current` | Link to the live release; every unit runs from here |
| `/etc/lemniscate/lemniscate.env` | Settings for every service (root, 0600) |
| `/etc/lemniscate/db.env` | `DATABASE_URL` and `POSTGRES_PASSWORD` with the random database password (root, 0600) |
| `/etc/lemniscate/<service>.env` | One per service (root, 0600), overrides values for that service only (for example `keeper.env`) |
| `/etc/lemniscate/keys/` | The keystores (`<role>.json`) and their password files (`<role>.password`), copied in by the owner |
| `/var/lib/lemniscate/<service>` | Home and only writable dir of that service's user (0700) |
| `/var/backups/lemniscate` | Database dumps |

Services (only 22, 80 and 443 are open to the internet):

| Unit | Port | Key (keystore role) | Public |
| --- | --- | --- | --- |
| `lemniscate-api` | 3101 | `paymaster-signer` and `x402-settler`, both optional | `https://api.<domain>` |
| `lemniscate-indexer` | none | none | no |
| `lemniscate-keeper` | none | `keeper` | no |
| `lemniscate-hedger` | none | `hedger` (gas only; `HEDGER_DRY_RUN=1` by default) | no |
| `lemniscate-vol-engine` | none | `vol-signer` (`VOL_SEND=0` by default) | no |
| `lemniscate-mcp` | 3102 | none (read-only) | off by default; `https://mcp.<domain>` if `MCP_DOMAIN` is set |

Keeper, hedger and vol signer are three different keys (the services refuse to start with duplicates). Only the API has
an HTTP health route (`/v1/health`); it also reports the indexer lag and each keeper job from the database. The other
services are checked by systemd state and a settle window.

## Keys

Every signer loads its own encrypted keystore (Web3 Secret Storage v3, what `cast wallet import` writes). A unit points its
service at `/etc/lemniscate/keys/<role>.json` and `<role>.password` with `<PREFIX>_KEYSTORE` and
`<PREFIX>_KEYSTORE_PASSWORD_FILE` (`KEEPER_`, `HEDGER_`, `VOL_SIGNER_`, `PAYMASTER_SIGNER_`, `X402_SETTLER_`); the service
decrypts it in its own memory. A key is never in an environment variable, never on a command line, never written to disk or
logged, and the password is only ever read from a file. With `NODE_ENV=production` (set in `lemniscate.env`) a service
refuses a raw key variable and refuses a keystore or password file that other users can read.

`deploy.sh` also refuses a raw `*_PRIVATE_KEY`, `*_SIGNER_KEY`, `*_SETTLER_KEY` or `AGENT_KEY` line in any env file, writes
`/etc/lemniscate/api-keys.env` (paths only) for the optional paymaster and x402 keystores that exist, and runs
`bun src/bin/check-keys.ts /etc/lemniscate/keys` as the service user: every keystore must unlock with its password file, no two
roles may control the same address, and it prints each role's public address so you can compare it with the wallet pack.
The owner wallet never goes on a server. Local development can still use `KEEPER_PRIVATE_KEY` and the like with
`NODE_ENV` unset.

## Steps, in order

1. **Server.** Create the VPS with your SSH key for root. Its address never goes into any file in this repository.
2. **DNS.** Point `api.<your-domain>` (A record, and AAAA if the server has IPv6) at the server, Cloudflare grey cloud (DNS only). See [Cloudflare](#cloudflare).
3. **Provision.** From the repository on your machine:

   ```sh
   API_DOMAIN=api.<your-domain> ACME_EMAIL=<you@example.com> app/scripts/server/deploy.sh --provision <server>
   ```

   `<server>` is the address, an `~/.ssh/config` alias, or `user@address` (root by default). Extra ssh options go in `SSH_OPTS`.
   Add `MCP_DOMAIN=mcp.<your-domain>` to publish the MCP server. This copies this folder to `/root/lemniscate-server` and runs `provision.sh` there.
4. **Settings.** On the server, edit `/etc/lemniscate/lemniscate.env` and replace each `CHANGE_ME`: `CORS_ORIGINS` (the website origins), `VOL_ORACLE_ADDRESS` (from the deployment output), `ALPHAVANTAGE_API_KEY` (free key; empty keeps the earnings import off). `deploy.sh` compares `VOL_ORACLE_ADDRESS` with `4663.json`.
5. **Keys.** Copy the keystore and password file of each role into `/etc/lemniscate/keys/` with these names, then lock them down:

   ```
   keeper.json          keeper.password
   hedger.json          hedger.password
   vol-signer.json      vol-signer.password
   paymaster-signer.json  paymaster-signer.password     (only if sponsoring gas; also set PAYMASTER_ADDRESS)

   bash /root/lemniscate-server/provision.sh --service-users
   ```

   That gives each file to the one service that signs with it (`keeper` to `lem-keeper`, `hedger` to `lem-hedger`, `vol-signer` to `lem-vol-engine`, `paymaster-signer` and `x402-settler` to `lem-api`), group-readable only by that user, mode 0440. `deploy.sh` runs it again and refuses to continue if another service user can open a keystore.
6. **Deployment file.** `deploy.sh` ships `app/deployments/4663.json` (point `LEMNISCATE_DEPLOYMENTS_SRC` at another folder if it lives elsewhere). It refuses a file that is not chain 4663 `mainnet` or has a `forkProof`.
7. **Deploy.**

   ```sh
   app/scripts/server/deploy.sh <server>
   ```

   It refuses to start anything while a `CHANGE_ME` is left, if the RPC does not answer chain id 4663, if `4663.json` and `lemniscate.env` disagree on the oracle address, if a raw key is in an env file, or if the service that signs with a keystore cannot read it (or another service can). Then it installs, migrates, and restarts the services one by one (indexer, api, keeper, hedger, vol-engine, mcp if enabled), checking each before the next. Exit code 0 means every service is healthy. If one is not, the link goes back to the previous release, every service is restarted on it, and the exit code is 1. Only committed code is shipped (`--ref <commit|tag>` for another one). Add `LEMNISCATE_PUBLIC_API_URL=https://api.<your-domain>` to also check from outside once DNS and the certificate are in place.
8. **Every later release:** step 7 again. `deploy.sh --check <server>` re-runs the checks without changing anything.

## Day to day

```sh
systemctl status 'lemniscate-*'              # every unit
journalctl -u lemniscate-keeper -f           # follow one service's log
systemctl restart lemniscate.target          # restart everything
systemctl stop lemniscate.target             # stop everything
systemctl list-timers 'lemniscate-*'         # backup timer
```

**Roll back by hand:** `ls -t /opt/lemniscate/releases`, then `ln -sfn releases/<older> /opt/lemniscate/current && systemctl restart lemniscate.target`. Migrations are not reversed, so roll back only to a release that has the same migrations, or restore a backup.

**Switching on what is off.** Hedger trades: set `HEDGER_DRY_RUN=0` in `lemniscate.env` after reading a few dry-run cycles in its log, then `systemctl restart lemniscate-hedger`. Vol posts are sent: `VOL_SEND=0` to `1`, then restart `lemniscate-vol-engine`. MCP: `systemctl enable lemniscate-mcp`, set `MCP_DOMAIN`, re-run `provision.sh`, deploy. x402 stays off (see `env.example`).

## Backups

`lemniscate-backup.timer` runs `backup.sh` every night at about 03:15: a `pg_dump` (custom format, checked with `pg_restore --list`) into `/var/backups/lemniscate`, dumps older than 14 days deleted. Run one now with `systemctl start lemniscate-backup`. The dumps live on the same disk as the database, so also copy them off the server regularly. To restore into a TimescaleDB database, create an empty database with the extension, put it in restore mode, restore, and finish:

```sh
systemctl stop lemniscate.target
runuser -u postgres -- psql -d lemniscate_mainnet -c "SELECT timescaledb_pre_restore();"
runuser -u postgres -- pg_restore --clean --if-exists --no-owner --role=lemniscate -d lemniscate_mainnet /var/backups/lemniscate/<file>.dump
runuser -u postgres -- psql -d lemniscate_mainnet -c "SELECT timescaledb_post_restore();"
systemctl start lemniscate.target
```

## Cloudflare

The API takes the client address from `X-Forwarded-For` (`API_CLIENT_IP_HEADER`). Caddy sets it itself and removes `CF-Connecting-IP` and `CF-IPCountry` from every request, because a client could otherwise forge them. If you put Cloudflare's proxy (orange cloud) in front, allow 80 and 443 only from Cloudflare's address ranges in ufw, set `API_CLIENT_IP_HEADER=cf-connecting-ip`, and delete the two `header_up -CF-...` lines from the `Caddyfile` template, then run `provision.sh` again. Doing only part of that either breaks the rate limit or lets clients choose their own address.

## What provision.sh sets up

- One system user per service (no login shell): `lem-api`, `lem-indexer`, `lem-keeper`, `lem-hedger`, `lem-vol-engine`, `lem-mcp`. Each has a read-only view of the system (`ProtectSystem=strict`), write access only to its own `/var/lib/lemniscate/<service>`, its own env file, and (for the signers) only its own keystore. A flaw in one service cannot read another's key. The `lemniscate` user owns the releases and runs the migrations and nothing else. All services still share one Postgres role (`db.env`); a separate role per service is a later hardening step.
- Postgres from Ubuntu (its current major version) plus `timescaledb-2-postgresql-<major>` from Timescale's apt repository (falls back to the `noble` packages if the release is not published yet; set `TIMESCALE_CODENAME` to override), listening on localhost only, with a `lemniscate` role and the `lemniscate_mainnet` database that has the extension.
- ufw: inbound 22/tcp, 80/tcp and 443 only. fail2ban on SSH. SSH password logins off when root has an authorized key. `hidepid=2` on `/proc`.
- Unattended security upgrades, a 2 GB swap file when there is none, NTP on, journald capped at 1 GB / 30 days.
- Bun 1.4.2 (checksum-checked against the release's `SHASUMS256.txt`) and cast 1.8.4 in `/usr/local/bin`; Python 3 with venv for the vol engine.
- Caddy with automatic HTTPS for the API (and MCP).
- The systemd units and the nightly backup.
