# Local setup and how to adapt IPs / ports for your server

This short guide explains how to take the repository files and configure them to run on your server with your IPs and ports.

1) Checkout the prepared branch

```bash
git fetch origin
git checkout -b setup/local-dev origin/setup/local-dev
```

2) Copy .env.local to .env (or export variables)

```bash
cp .env.local .env
# or load variables to the current shell
export $(grep -v '^#' .env.local | xargs)
```

3) Replace placeholders

- TELESRV_ADVERTISE_IP: set to your public IP or DNS name (the value clients will use to reach media/calls).
- TELESRV_LISTEN: the bind address for the MTProto server. Keep 0.0.0.0 if you want to accept external connections, or 127.0.0.1 for local-only testing.
- TELESRV_POSTGRES_DSN / TELESRV_REDIS_ADDR: set to your actual Postgres / Redis endpoints if different from local compose.
- TELESRV_PUBLIC_BASE_URL / TELESRV_PUBLIC_WEB_BASE_URL: set to your external HTTPS base URLs used in generated links.

4) Start Postgres and Redis (recommended: docker compose)

```bash
docker compose -f deploy/docker-compose.yml up -d
```

If you changed Postgres/Redis ports, update TELESRV_POSTGRES_DSN and TELESRV_REDIS_ADDR accordingly.

5) Build and run the server

Linux / macOS:

```bash
go build -o bin/gramsrv ./cmd/telesrv
./bin/gramsrv
```

Windows (PowerShell):

```powershell
go build -o bin/gramsrv.exe ./cmd/telesrv
.\bin\gramsrv.exe
```

6) Public deployment notes

- Keep TELESRV_PUBLIC_LINK_WEB_ADDR on loopback and use a reverse proxy (nginx) to present HTTPS and public hostname/ports to users.
- If you expose MTProto on a custom port, update TELESRV_LISTEN and make sure firewall / NAT maps it.
- For Telegram client compatibility (patched clients), you will also need to export data/server_rsa.pub and use it in the client patch as described in README.

7) Short checklist after first start

- `data/server_rsa.pem` was created
- migrations applied successfully
- MTProto is listening on the configured TELESRV_LISTEN
- Redis/Postgres connections are healthy

8) Next steps you may want me to do for you

- Create a small docker-compose override with host port mappings for production
- Add a README section in Russian with step-by-step commands tailored to your server
- Create a GitHub Actions workflow to build the binary on commits

If you want, I can now open a pull request in your repository from setup/local-dev to your main branch, or you can pull the branch locally. Tell me which you'd prefer.