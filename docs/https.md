# HTTPS in front of jvinu

On a server reachable from the internet, put jvinu behind HTTPS. The `proxy` profile adds
[Caddy](https://caddyserver.com), which gets and renews a Let's Encrypt certificate by itself.

1. Point your domain's DNS (an A/AAAA record) at the server, and open ports 80 and 443.
2. In `.env`:

   ```sh
   JVINU_DOMAIN=files.example.com
   JVINU_PUBLIC_URL=https://files.example.com
   # Only Caddy talks to jvinu directly…
   JVINU_BIND=127.0.0.1
   # …so the address it passes on can be trusted for rate limits.
   JVINU_TRUST_PROXY=1
   ```

3. `docker compose --profile proxy up -d`

Caddy replaces any `X-Forwarded-For` a client sends with the address it really saw, which
is what makes `JVINU_TRUST_PROXY=1` safe: sign-in throttling and share-link limits then count
each real sender separately. Without a proxy, leave `JVINU_TRUST_PROXY` unset — a client could
otherwise forge its address.

Large uploads stream straight through Caddy with no size or time limit; jvinu's own
`JVINU_MAX_UPLOAD_MB` still applies. Using another proxy (nginx, Traefik, a load balancer)?
Make it **overwrite** `X-Forwarded-For` and `X-Forwarded-Proto`, not append to what the
client sent, and turn off request buffering for `/api/connections/*/upload`.
