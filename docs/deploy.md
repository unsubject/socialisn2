# Deploying socialisn2

Two surfaces deploy independently:

| Surface                                       | Workflow                                  | Trigger                       |
|-----------------------------------------------|-------------------------------------------|-------------------------------|
| Cloudflare Workers (email-worker, feed-worker) | `.github/workflows/deploy-workers.yml`    | auto on push to `main`        |
| VPS stack (app + workers + nginx + Postgres)   | `.github/workflows/deploy-vps.yml`        | `workflow_dispatch` only      |

The Workers are stateless and reach a separate D1 database; rolling them on every push is safe. The VPS deploy touches Postgres, restarts background workers, and re-runs migrations — keep it manual until the Phase 5 PR 4 pilot signs off on auto-deploy.

The VPS deploy runs on a **self-hosted GitHub Actions runner** installed on srv1565522 itself. The runner polls GH outbound, so there's no inbound surface (no SSH key in repo secrets, no firewall hole, no rotating runner IPs to allowlist). The trade-off: anyone with push to `main` can execute arbitrary code on srv1565522 via workflow YAML. For a private repo with you as sole pusher, this is fine — but treat the repo's collaborator list as the VPS's effective ACL.

## One-time VPS bootstrap

These prereqs the deploy workflow can't do on its own. All commands as root unless noted.

1. **Create the deploy user.** Non-root user with docker access. Don't reuse root for the runner — `actions/runner` refuses to configure as root.
   ```sh
   useradd -m -G docker -s /bin/bash deploy
   ```

2. **Pre-create `/opt/socialisn2` owned by deploy.** The workflow's first step clones the repo here; deploy needs write access.
   ```sh
   mkdir -p /opt/socialisn2
   chown -R deploy:deploy /opt/socialisn2
   ```

3. **Populate `/opt/socialisn2/.env`** with every key listed in `.env.example`. The workflow refuses to proceed if `.env` is missing (sanity-check step). Make sure deploy can read it:
   ```sh
   chown deploy:deploy /opt/socialisn2/.env
   chmod 600 /opt/socialisn2/.env
   ```

4. **Install the self-hosted runner.** Get a one-time registration token from GitHub:
   - Browser: `https://github.com/unsubject/socialisn2/settings/actions/runners/new`
   - Or `gh`: `gh api -X POST repos/unsubject/socialisn2/actions/runners/registration-token --jq .token`
   
   Then as deploy (NOT root — `actions/runner` refuses root):
   ```sh
   su - deploy
   mkdir -p ~/actions-runner && cd ~/actions-runner
   A=actions-runner-linux-x64-2.334.0.tar.gz
   U=https://github.com/actions/runner/releases/download/v2.334.0
   curl -fsSL -o "$A" "$U/$A"
   tar xzf "$A"
   ./config.sh --url https://github.com/unsubject/socialisn2 \
     --token <PASTE-TOKEN> \
     --labels self-hosted,linux,x64 --unattended
   exit  # back to root
   ```
   
   Install as systemd service (as root — `svc.sh install <user>` configures the service to run as that user):
   ```sh
   cd /home/deploy/actions-runner
   ./svc.sh install deploy
   ./svc.sh start
   ./svc.sh status   # should show: active (running)
   ```

5. **Traefik must be running.** The existing reverse proxy on srv1565522 is the `traefik-yffq-traefik-1` container (its own compose project `traefik-yffq`). It runs in **`network_mode: host`** and discovers containers via the Docker socket, routing to each container's bridge IP from the host's network namespace — so socialisn2's services don't need to join any shared external network. The cert resolver is named **`letsencrypt`**. The workflow's sanity-check step verifies the Traefik container exists (`docker inspect traefik-yffq-traefik-1`).

6. **DNS for `mcp.socialisn.com`.** Cloudflare DNS record pointing at srv1565522's IP. **Proxy ON** (orange cloud). SSL mode must be **Full (strict)** at the zone level — `Flexible` causes a 301 loop with Traefik's HTTPS-only entry point. Memory note `railway_cloudflare_ssl` covers the same pattern from a different deploy.

7. **First deploy & RSS volume.** `feeds_data` is a named Docker volume, fresh on first deploy. nginx will return 404 for `/feeds/<slug>.xml` until the next scoring tick (cron at 05:00 / 14:00 ET) regenerates the files. To force a regen sooner, MCP `run_now` or `docker compose exec scoring-worker node -e 'import("./dist/orchestrator/run.js").then(m => …)'` — but waiting for the next cron is usually fine.

## Required GitHub Actions secrets

For the VPS-side deploy: **none.** The self-hosted runner is authenticated by virtue of being registered with the repo; no SSH key, no host secret needed.

The Cloudflare-side deploy (`deploy-workers.yml`) still uses two existing secrets:

| Secret name             | Used by                | Notes                                                                 |
|-------------------------|------------------------|-----------------------------------------------------------------------|
| `CLOUDFLARE_API_TOKEN`  | deploy-workers         | Tracked under a separate scoped-token Build task; see PR #67 history |
| `CLOUDFLARE_ACCOUNT_ID` | deploy-workers         | account-level id                                                    |

> Legacy: an earlier iteration of `deploy-vps.yml` used `VPS_HOST` / `VPS_USER` / `VPS_SSH_PRIVATE_KEY` for an SSH-based deploy. The self-hosted runner replaced that; the secrets can be deleted from repo settings (no consumer remains), or left untouched.

## Required `.env` keys on the VPS

The Phase 5 PR 2 deploy reads `/opt/socialisn2/.env` for everything the app + workers need. Highlights of what `post-deploy-backfill` will hard-abort on if missing:

- `PUBLIC_HOST=mcp.socialisn.com`
- `RSS_PATH=/var/www/socialisn2/feeds`
- `SOCIALISN2_MCP_TOKEN=<long random>` — without this the `/mcp` route doesn't mount (Traefik still routes there → 404)
- `TWO_BRAIN_MCP_URL` + `TWO_BRAIN_MCP_TOKEN` — leaving either empty surfaces as `brain_corpus_status='not_configured'` and the deploy aborts
- `DATABASE_URL`, `POSTGRES_PASSWORD`, `LITELLM_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `ANTHROPIC_API_KEY` — standard runtime requirements

See `.env.example` for the full list with inline guidance.

## Running a deploy

```
gh workflow run deploy-vps.yml
gh run watch
```

Or via the GitHub UI: Actions → deploy-vps → "Run workflow".

Expected duration: ~2-3 min for an image-unchanged deploy, ~5-8 min if the `app` image rebuilds.

The final step runs `dist/scripts/post-deploy-backfill.js` inside a one-shot `app` container. A green workflow guarantees, at the moment the workflow finishes:

- Latest `main` is checked out at `/opt/socialisn2`
- Postgres schema is migrated forward to the latest file in `migrations/`
- `app`, `ingestion-worker`, `scoring-worker`, `whisper-worker`, `nginx` containers have **started** (passed initial `docker compose up` — continuous-liveness verification is Phase 5 PR 3 scope)
- A `backfill_run` row was inserted with `status='completed'`, `brain_corpus_status='available'`

If the workflow goes red on the post-deploy step, the stack is still running — the assertion failure means scoring Stage 5 will degrade to `archive_overlap=0` on every run until the underlying `TWO_BRAIN_MCP_URL` / token is fixed. Repair the env, re-run the workflow.

## Rolling back

Migrations are forward-only. To revert code, the supported path is **revert the bad commit on main, then redeploy**:

```
git revert <bad-sha>
git push origin main
gh workflow run deploy-vps.yml
```

This rebuilds the `app` image from the post-revert tree, runs any pending forward migrations, and brings the stack up clean.

> ⚠️ **`gh workflow run deploy-vps.yml --ref <prior-sha>` is NOT a rollback.**
> The workflow always does `git reset --hard origin/main` on the VPS regardless of which `--ref` triggered it, so passing an older SHA only selects which version of the workflow YAML executes — the code that gets deployed is still current `main`. To deploy a different revision, that revision must be `main`.

If the workflow itself is broken (or GitHub is down) and you need to roll back via the VPS directly:

```
ssh root@srv1565522.hstgr.cloud   # your normal admin SSH, allowlisted to one source IP
cd /opt/socialisn2
git fetch origin
git checkout <prior-sha>
docker compose build app   # rebuild from the older Dockerfile/src
docker compose up -d
```

If a rollback requires a schema reverse (column drop, etc.), write a new forward migration file rather than reverting `_socialisn2_migrations`.

## Maintaining the runner

The runner runs as a systemd service. Common operations (as root):

- **Stop / start / status:** `cd /home/deploy/actions-runner && ./svc.sh stop|start|status`
- **Upgrade runner version:** `./svc.sh stop`, replace tarball, `./svc.sh start`. The runner auto-updates the worker binary on each job, but the `runsvc` host process needs a manual upgrade for major versions.
- **Deregister and rebuild:** as `deploy`, `./config.sh remove --token <fresh-token>`; then redo the install steps.

GitHub shows runner status under repo settings → Actions → Runners. If the runner is `Offline`, check the systemd unit (`systemctl status actions.runner.unsubject-socialisn2.srv1565522.service`).

## Where requests land

After Traefik picks up the new labels:

| URL                                            | Routed to        |
|-----------------------------------------------|------------------|
| `https://mcp.socialisn.com/feeds/all.xml`     | nginx container  |
| `https://mcp.socialisn.com/feeds/economy.xml` | nginx container  |
| `https://mcp.socialisn.com/c/<uuid>`          | app container    |
| `https://mcp.socialisn.com/mcp` (POST, bearer) | app container    |
| `https://mcp.socialisn.com/healthz`           | app container    |
| `https://inbox.socialisn.com/feeds/<slug>.xml` | feed-worker (CF)|

The two `socialisn.com` subdomains serve different purposes: `inbox.` is the email-bridge ingestion path (CF Worker, D1-backed); `mcp.` is the editorial-intelligence surface (VPS, Postgres-backed).
