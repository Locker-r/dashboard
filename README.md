# Reactivation Desk Dashboard

Use one canonical development address:

```text
http://localhost:3000
```

`http://127.0.0.1:3000`, any other port, and a published domain are different origins and therefore have separate `localStorage` data. Starting and stopping the HTTP server at the canonical address does not clear browser users.

## Supabase Auth configuration

The dashboard is a static application, so it reads Supabase settings from a local runtime configuration file rather than `.env`.

1. Copy `config/supabase-config.example.js` to `config/supabase-config.local.js`.
2. Set `projectUrl` to the Supabase Project URL.
3. Set `publishableKey` to the Supabase Publishable key. Never use a secret or `service_role` key.
4. Run `npm install` and `npm run build:vendor` after cloning or updating dependencies.

`config/supabase-config.local.js` and `node_modules` are ignored by Git. The generated `vendor/supabase.js` bundle is served locally, so the dashboard does not depend on a CDN.

Supabase storage setup is documented in `docs/supabase-storage-foundation.md`. The optional atomic write RPC migration and its manual verification workflow are documented in `docs/supabase-atomic-writes.md`; repository scripts never apply SQL to a remote project.
