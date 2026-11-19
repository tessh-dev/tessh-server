# Development

## Development

Needs Node.js 24 or newer (the server uses the built-in `node:sqlite`; it has no runtime dependencies).

```sh
npm install
npm test          # unit and end-to-end tests (vitest)
npm run typecheck
PUBLIC_URL=http://127.0.0.1:8080 DATA_DIR=./data npm run dev
npm run build && npm start   # the compiled output, as the image runs it
```

Layout: `src/index.ts` is the request handler (`fetch(request, env)` style), `src/server.ts` adapts it to
`node:http`, `src/db.ts` is the small SQLite layer, `src/migrate.ts` applies `migrations/*.sql`, and
`src/web/` holds the setup, panel and invite pages. The design is in
[docs/design/web-setup-and-panel.md](design/web-setup-and-panel.md).

[← Back to the README](../README.md)
