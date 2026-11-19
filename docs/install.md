# Install and HTTPS

## HTTPS with a reverse proxy

The apps need HTTPS, so put a reverse proxy in front of port 8080. The server reads `X-Forwarded-Proto`
and `X-Forwarded-Host`, which both examples below send. Once the proxy is up, open
`https://sync.example.com/setup` and use that as the address in setup. Do setup there rather than on
plain port 8080 once the proxy is running: the setup code and your owner password travel over that
connection.

If the proxy runs on the same machine, change the compose port to `"127.0.0.1:8080:8080"` so the server is
only reachable through it.

### Caddy

Caddy gets and renews the certificate on its own:

```caddyfile
sync.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name sync.example.com;

    ssl_certificate     /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

server {
    listen 80;
    server_name sync.example.com;
    return 301 https://$host$request_uri;
}
```

The server uses a single public URL: `/v1/...` is the API, `/setup` and `/admin` are setup and the panel,
`/join/<code>` is the invite page, and everything else is key pages. It must be served from the root of a
domain or subdomain, not under a path.


## Upgrading

```sh
docker compose pull
docker compose up -d
```

Database migrations run automatically at start. Each one runs once, in a transaction, so restarting is
always safe. Take a backup before upgrading. When a newer release exists, the panel says so in the sidebar
and under **Maintenance**. Releases are tagged `vX.Y.Z`; pin a tag such as `ghcr.io/tessh-dev/tessh-server:1.1.0`
instead of `latest` if you prefer to upgrade by hand. To build the image yourself instead, run
`docker compose up -d --build`.


## Locked out

If you lose the owner password (or the authenticator), reset the owner login. Your data and everyone's
accounts are untouched.

```sh
docker compose exec tessh-server tessh-server reset-owner
docker compose restart tessh-server
docker compose logs tessh-server
```

The log prints a new setup code. Open `/setup`, type it and choose a new owner login.

[← Back to the README](../README.md)
