# Backups and configuration

## Backups

The server keeps a copy of its database for you: a nightly backup at 03:00 server time into
`/data/backups/`, the newest 7 kept. It is one SQLite file (`tessh-YYYY-MM-DD.db`), made so it is safe
while the server runs.

To take one now, open **Maintenance** in the panel and choose **Download a backup**. It asks for the owner
password first.

Everything lives in the `/data` volume: `tessh.db`, `secrets.json` and the `backups` folder. **Back up
`secrets.json` as well**, and keep copies somewhere other than this machine. To copy the whole volume:

```sh
docker compose stop
docker run --rm -v tessh-server_tessh-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/tessh-$(date +%F).tar.gz -C /data .
docker compose start
```

(The volume name is `<project>_tessh-data`; check it with `docker volume ls`.)

To restore, stop the server, put `tessh.db` (or a downloaded backup renamed to `tessh.db`) and
`secrets.json` back into the volume, remove any stale `tessh.db-wal` and `tessh.db-shm`, and start it again.


## Configuration

Nothing here is required: setup asks for the name, address and sign-up mode in the browser, and you can
change them later in the panel. Set one of these in the compose file only to fix it. A setting fixed this
way is locked in the panel.

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | (optional) | The public origin of the server, e.g. `https://sync.example.com`. No path. Key page links and install commands use it. |
| `SERVER_NAME` | `Tessh` | Name shown on the home page and in the apps. |
| `SIGNUPS` | `invite` | `open`: anyone can create an account. `invite`: only people with an invite link. `closed`: no new accounts. |
| `UPDATE_CHECK` | `true` | `false` turns off the daily check for a newer release. This check is the only call the server makes to another site: it asks GitHub for the latest release number and sends nothing about you. |
| `PORT` | `8080` | Port to listen on. |
| `BIND` | `0.0.0.0` | Address to listen on. |
| `DATA_DIR` | `/data` | Where the database (`tessh.db`), backups and `secrets.json` live. |
| `PRELOGIN_SECRET` | (from `secrets.json`) | Optional. Overrides the stored sign-in secret. |
| `TOTP_KEY` | (from `secrets.json`) | Optional. Overrides the stored two-step key: base64 of 32 bytes (`openssl rand -base64 32`). |

### Server secrets

The server needs two secrets: one for sign-in (it keeps unknown emails from being told apart from real
ones) and one that encrypts each account's two-step (TOTP) secret at rest. On first start, if they are
not set in the environment, the server creates both and writes them to `DATA_DIR/secrets.json` with
mode `0600`.

> **Back up `secrets.json` together with the database.** If `TOTP_KEY` is lost or changed, every
> authenticator and backup code enrolled for two-step sign-in stops working, and those people need the
> owner to reset their two-step. Vaults themselves are not affected: they are encrypted by the apps,
> not by these secrets.

[← Back to the README](../README.md)
