# Reactivation Desk Dashboard

Use one canonical development address:

```text
http://localhost:3000
```

`http://127.0.0.1:3000`, any other port, and a published domain are different origins and therefore have separate `localStorage` data. Starting and stopping the HTTP server at the canonical address does not clear browser users.
