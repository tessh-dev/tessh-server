# Security

## Security notes

- **End-to-end encryption.** The apps encrypt everything before upload. The server stores a hash of a
  key derived from the master password (never the password itself), the encrypted vault key and
  encrypted items. Someone with the database cannot read anyone's vault.
- **Always use HTTPS** in front of the server. Sign-in tokens and the owner session travel in headers and
  cookies. Setup warns you when the address isn't HTTPS.
- **Protect the owner login.** Use a long password and turn on the authenticator code. Panel writes are
  refused from other sites, and downloading a backup needs the owner password again.
- **Rate limits.** Password and two-step attempts are limited per account (10 per 15 minutes), recovery
  code attempts more tightly (5 per hour). Owner sign-ins allow 5 failures per address in 15 minutes, and
  after 200 failures from all addresses together everyone waits out the 15 minutes. Wrong invite codes allow
  10 per address and 200 in all per 15 minutes. Consider rate limiting at your proxy as well.
- **Client addresses.** The server trusts `X-Forwarded-For` only when the connection comes from a loopback
  or private address (a reverse proxy on the same machine or network). Anything else is limited by the
  address it connects from, so don't expose a private-network proxy that passes through headers from
  untrusted clients.
- **Logs** never contain request bodies, tokens or keys.
- **`secrets.json`** is created with mode `0600`. Keep backups of it as private as the database.
- **No tracking, one outbound call.** The only request the server makes is the daily update check
  (`UPDATE_CHECK=false` stops it).
- The container runs as the unprivileged `node` user and needs nothing but its volume.
- Found a security problem? Please open a private security advisory on GitHub rather than a public issue.

[← Back to the README](../README.md)
