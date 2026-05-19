# Deploying socialisn2

Two surfaces deploy independently:

| Surface                                       | Workflow                                  | Trigger                       |
|-----------------------------------------------|-------------------------------------------|-------------------------------|
| Cloudflare Workers (email-worker, feed-worker) | `.github/workflows/deploy-workers.yml`    | auto on push to `main`        |
| VPS stack (app + workers + nginx + Postgres)   | `.github/workflows/deploy-vps.yml`        | `workflow_dispatch` only      |

The Workers are stateless and reach a separate D1 database; rolling them on every push is safe. The VPS deploy touches Postgres, restarts background workers, and re-runs migrations — keep it manual until the Phase 5 PR 4 pilot signs off on auto-deploy.

## One-time VPS bootstrap

These prereqs the deploy workflow can't do on its own.

1. **Repo location.** Clone `unsubject/socialisn2` to `/opt/socialisn2` on srv1565522.
2. **Populate `/opt/socialisn2/.env`** with every key listed in `.env.example`. Missing keys surface as `env.publicHost() throws "Missing required env var PUBLIC_HOST"` at app startup; the deploy gets through migrations but fails the post-deploy backfill assertion (confusing).
3. **Traefik + LE resolver.** The existing n8n stack on srv1565522 owns the `n8n-traefik-1` Docker network and `mytlschallenge` resolver. Confirm both exist before the first deploy (`docker network inspect n8n-traefik-1`). Memory note `hostinger_traefik_cf_pattern` covers the pattern.
4. **DNS for `mcp.socialisn.com`.** Cloudflare DNS record pointing at srv1565522's IP. **Proxy ON** (orange cloud). SSL mode must be **Full (strict)** at the zone level — `Flexible` causes a 301 loop with Traefik's HTTPS-only entry point. Memory note `railway_cloudflare_ssl` covers the same pattern from a different deploy.
5. **First deploy & RSS volume.** `feeds_data` is a named Docker volume, fresh on first deploy. nginx will return 404 for `/feeds/<slug>.xml` until the next scoring tick (cron at 05:00 / 14:00 ET) regenerates the files. To force a regen sooner, MCP `run_now` or `docker compose exec scoring-worker node -e 'import("./dist/orchestrator/run.js").then(m => …)'` — but waiting for the next cron is usually fine.

## Required GitHub Actions secrets

`.github/workflows/deploy-vps.yml` needs three new secrets in addition to the Workers-side ones that already exist:

| Secret name             | Used by              | Notes                                                                 |
|-------------------------|----------------------|-----------------------------------------------------------------------|
| `VPS_HOST`              | deploy-vps           | `srv1565522.hstgr.cloud` or the raw IP                                |
| `VPS_USER`              | deploy-vps           | SSH user on the VPS with permission to run `docker compose`           |
| `VPS_SSH_PRIVATE_KEY`   | deploy-vps           | ed25519 private key; matching public key in the VPS user's `~/.ssh/authorized_keys` |
| `CLOUDFLARE_API_TOKEN`  | deploy-workers (existing) | Tracked under a separate scoped-token Build task; see PR #67 history |
| `CLOUDFLARE_ACCOUNT_ID` | deploy-workers (existing) | account-level id                                                    |

Adding the SSH key: generate locally with `ssh-keygen -t ed25519 -C "gha-deploy" -N "" -f gha_deploy_key`, append the `.pub` to `~/.ssh/authorized_keys` on the VPS for `$VPS_USER`, paste the private key into the GH Actions secret.

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

The final step runs `dist/scripts/post-deploy-backfill.js` inside a one-shot `app` container. A green workflow guarantees:

- Latest `main` is checked out at `/opt/socialisn2`
- Postgres schema is migrated forward to the latest file in `migrations/`
- `app`, `ingestion-worker`, `scoring-worker`, `whisper-worker`, `nginx` are running
- A `backfill_run` row was inserted with `status='completed'`, `brain_corpus_status='available'`

If the workflow goes red on the post-deploy step, the stack is still running — the assertion failure means scoring Stage 5 will degrade to `archive_overlap=0` on every run until the underlying `TWO_BRAIN_MCP_URL` / token is fixed. Repair the env, re-run the workflow.

## Rolling back

Migrations are forward-only. To revert code, **prefer the workflow** so the image gets rebuilt automatically:

```
gh workflow run deploy-vps.yml --ref <prior-sha>
```

That checks out the older commit on the VPS via the workflow's `git reset --hard origin/main` step (NB: the workflow always pulls origin/main regardless of the `--ref` used to launch it — the `--ref` only picks which version of the workflow YAML runs). To roll back to an arbitrary SHA, instead update main via `git revert <bad-sha> && git push` and run the workflow.

If you must reach the VPS directly (workflow broken, GH outage):

```
ssh $VPS_USER@$VPS_HOST
cd /opt/socialisn2
git fetch origin
git checkout <prior-sha>
docker compose build app   # rebuild from the older Dockerfile/src
docker compose up -d
```

If a rollback requires a schema reverse (column drop, etc.), write a new forward migration file rather than reverting `_socialisn2_migrations`.

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
