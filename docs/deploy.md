# Hosted setup: runbook

The controller, dashboard, DB and forges run on one small VPS; agents run on an agent host behind a runner (the
laptop for now). Design: [docs/plans/2026-10-12-hosted-control-plane.md](plans/2026-10-12-hosted-control-plane.md).

```
your devices ──tailnet──▶ VPS: controller (dashboard + API :7777, forges, backups)  ◀── CI (ssh, forced command)
                           │  starts every call                ▲ forge ports only
                           ▼                                   │
                 agent host: runner :7701 ── agent containers ─┘ (+ egress proxy, search/fetch relay)
public internet ──443──▶ VPS: Caddy ──▶ controller's public forge proxy (read-only) ──▶ forges
```

## 1. Tailscale

Tags and access rules (tailnet policy file):

```jsonc
"tagOwners": { "tag:swarm-control": ["autogroup:admin"], "tag:swarm-agents": ["autogroup:admin"], "tag:ci": ["autogroup:admin"] },
"acls": [
  // Your devices -> VPS: dashboard + API, SSH.
  { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:swarm-control:7777,22"] },
  // VPS -> agent hosts: the runner.
  { "action": "accept", "src": ["tag:swarm-control"], "dst": ["tag:swarm-agents:7701"] },
  // Agent hosts -> VPS: forge ports only (one per world, from FORGE_PORT).
  { "action": "accept", "src": ["tag:swarm-agents"], "dst": ["tag:swarm-control:3301-3399"] },
  // CI -> VPS: SSH (the forced deploy command).
  { "action": "accept", "src": ["tag:ci"], "dst": ["tag:swarm-control:22"] }
]
```

CI joins with an OAuth client that may create ephemeral `tag:ci` nodes (`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`).

A tailnet on the newer `grants` syntax writes each rule as `{ "src": […], "dst": ["tag:swarm-control"], "ip":
["7777", "22"] }`. Replace the default allow-all grant (`"src": ["*"], "dst": ["*"], "ip": ["*"]`) with
`{ "src": ["autogroup:member"], "dst": ["autogroup:member"], "ip": ["*"] }`: your own (untagged) devices keep full
access to each other, and the tagged nodes (the VPS, CI) get only the rules above. A laptop tagged `tag:swarm-agents`
is no longer a member device, so give yourself a grant to it if it is also your daily machine.

## 2. Bootstrap the VPS (once)

OVH, 2 vCores, 4 GB RAM, 40 GB disk, Debian 13, installed with your SSH key (OVH: *My offers and services → SSH keys*,
then *Reinstall my VPS* with the key selected; the user is `debian`). Everything on the box is
[deploy/vps/bootstrap.sh](../deploy/vps/bootstrap.sh): Docker, Tailscale, the directories, the env file skeleton, the
deploy user with its forced command, keys-only sshd. It is idempotent and never touches containers (those are
`slopswarm-deploy`'s).

1. The CI deploy key, on the laptop: `ssh-keygen -t ed25519 -N '' -C slopswarm-ci-deploy -f ~/.ssh/slopswarm-ci-deploy`.
   Its private half becomes the GitHub secret `DEPLOY_SSH_KEY`; it can only run `slopswarm-deploy`.
2. Copy `deploy/` over and run the bootstrap twice:

   ```sh
   scp -r deploy debian@<VPS_IP>:slopswarm-deploy-src
   ssh debian@<VPS_IP>
   sudo ./slopswarm-deploy-src/vps/bootstrap.sh       # first run: creates /etc/slopswarm/deploy.conf and stops
   sudo nano /etc/slopswarm/deploy.conf               # CI_DEPLOY_PUBKEY (~/.ssh/slopswarm-ci-deploy.pub)
   sudo ./slopswarm-deploy-src/vps/bootstrap.sh       # installs everything; `tailscale up` prints a login URL
   ```

   Open the URL in the browser (or put a pre-authorized, tagged auth key in `deploy.conf` as `TS_AUTHKEY` first). The
   node joins as `slopswarm-vps` with `tag:swarm-control` (§1 must list the tag). Re-run the script once it has
   joined: it prints the tailnet address, the env file values and the `VPS_SSH_KNOWN_HOSTS` line for CI.
3. `/etc/slopswarm/slopswarm.env` (root, 0600, created from
   [deploy/slopswarm.env.example](../deploy/slopswarm.env.example)): every secret, the runner URL and token,
   `SLOPSWARM_API_TOKEN`, and the tailnet values the script printed. Later `PUBLIC_FORGE_DOMAIN` + `ACME_EMAIL`.
   Generate tokens with `openssl rand -base64 32`. The swarm's Codex login goes to
   `/etc/slopswarm/secrets/codex/auth.json` (0600).
4. On the laptop, `~/.ssh/config`:

   ```
   Host slopswarm-vps
     HostName slopswarm-vps.<tailnet>.ts.net
     User debian
     IdentityFile ~/.ssh/slopswarm-deploy
     IdentitiesOnly yes
   ```

   `ssh slopswarm-vps` must work before the next step.
5. Close public SSH, two layers:
   - `sudo ./slopswarm-deploy-src/vps/bootstrap.sh lock-ssh --confirm`: sshd listens on loopback and the tailnet
     address only.
   - OVH's Edge Network Firewall on the VPS's IPv4, one rule: deny tcp, destination port 22, sequence 0, then enable
     the firewall. It is stateless, so add nothing else (a deny-all would also drop the replies to the VPS's own DNS
     and NTP queries). Tailscale's traffic is outbound and unaffected. With the OVH CLI
     (`brew install --cask ovh/tap/ovhcloud-cli`, `ovhcloud login`): `ovhcloud ip firewall add <ip>/32 <ip>`,
     `ovhcloud ip firewall rule create <ip>/32 <ip> --action deny --protocol tcp --destination-port 22 --sequence 0`,
     `ovhcloud ip firewall enable <ip>/32 <ip>`; or the panel under *Network → Public IP*.
   - Break-glass if the tailnet is down: the OVH KVM console (*General information → … → KVM*) as `debian`, which
     needs a password (`sudo passwd debian`, keep it somewhere safe), then `sudo bootstrap.sh unlock-ssh` and
     disable the edge rule. Without a password: OVH rescue mode, mount the disk, delete
     `/etc/ssh/sshd_config.d/20-slopswarm-listen.conf`.
6. GHCR pull access if the packages are private: `docker login ghcr.io` (a read-only token) on the VPS and on each
   agent host.
7. The first deploy: run the workflow (§4) or by hand:
   `sudo slopswarm-deploy deploy ghcr.io/<owner>/slop-swarm-controller@sha256:… ghcr.io/<owner>/slop-swarm-agent@sha256:…`
8. Migrate existing data (optional): stop local runs, then `rsync -a data/ slopswarm-vps:/var/lib/slopswarm/` (the
   DB, worlds, runs). The next controller start moves pre-world runs into worlds.

Re-run `bootstrap.sh` after changing `deploy/vps/` or `deploy/slopswarm-deploy`; it only rewrites what changed.
Upgrades of Docker and Tailscale are by hand, between runs: `sudo apt-get install --only-upgrade docker-ce
docker-ce-cli containerd.io docker-compose-plugin tailscale` (Docker's `live-restore` keeps the containers up;
restarting tailscaled drops this SSH session, so run it detached: `sudo systemd-run --unit=ts-upgrade sh -c
'apt-get install -y --only-upgrade tailscale'`).

The controller runs with `network_mode: host` and the Docker socket (it starts forges): root-equivalent, on a
single-purpose VPS.

## 3. The agent host (runner)

A second checkout on the laptop (or a VM), on the tailnet with `tag:swarm-agents`:

```sh
just setup                                  # images, proxy, networks
RUNNER_TOKEN=… RUNNER_HOST=<agent host tailnet IP> just runner
```

The runner applies the host config the controller pushes (`config/host.yaml`: allowlist, container limits), pulls the
agent image by digest, and runs the world relays and the forge forwarders (`slopswarm-forge-<world>` → the VPS's
world port). On Linux it must run as uid 1000 (the agents' uid) in the docker group. It holds no VPS credentials. If
the controller goes silent while wakes run, the runner kills them after `runner.watchdog_s`; every wake also has a
hard timeout.

Before relying on a laptop runner, check that a forwarder container reaches the VPS through OrbStack's NAT:
`docker run --rm --network slopswarm-egress alpine/socat:1.8.0.3 -T3 - TCP:<vps tailnet IP>:3301 </dev/null && echo ok`.

## 4. CI deploys

[.github/workflows/deploy.yml](../.github/workflows/deploy.yml): tests on every push; with the repository variable
`DEPLOY_ENABLED=true`, a push to `main` builds the controller image (amd64) and the agent image (amd64 + arm64), pushes
both to GHCR by digest, joins the tailnet as `tag:ci`, and runs `deploy <controller@digest> <agent@digest>` through the
forced command. Secrets: see the workflow header.

What a deploy does ([deploy/slopswarm-deploy](../deploy/slopswarm-deploy)): one at a time (lock); pulls; if the DB
schema changed (`org.slopswarm.schema`), waits until no run is active (6 h at most); copies `compose.yaml` and the
`Caddyfile` out of the image; `docker compose up -d`; health-checks the API; rolls back to the previous digests if the
new controller doesn't come up.

Deploys don't kill wakes: the old controller gets SIGTERM and detaches (the run stays running, its containers keep
going); the new one resumes the run and follows the wakes again by offset.

## 5. Day to day

From a device on the tailnet, `SLOPSWARM_API=http://<vps>:7777 SLOPSWARM_API_TOKEN=… just <command>`:

| What | How |
| --- | --- |
| Start a run | `just up smoke` (new world), `just continue <world> smoke --brief "…"`, or the dashboard's Worlds page |
| Watch | the dashboard; `just status`, `just logs`, `just logs bramble` |
| Stop / kill | `just stop` / `just kill` |
| Config | dashboard Config page; `just config list|seeds|import|export` |
| Back up now | `just backup [world…]` |

## 6. Rollback

Deploy the previous digests by hand (they're in the workflow runs, and in `/opt/slopswarm/image.env` before a deploy):

```sh
sudo slopswarm-deploy deploy ghcr.io/<owner>/slop-swarm-controller@sha256:<previous> ghcr.io/<owner>/slop-swarm-agent@sha256:<previous>
```

A rollback across a schema change needs the DB from before it (restore, below): newer schemas are not migrated down.

## 7. Backups and restore

With `SLOPSWARM_BACKUPS=1` (in compose): the DB nightly (`backups/db/swarm-<time>.db`, a consistent `VACUUM INTO`
copy), each world's forge as plain files when its run ends and nightly when it changed (`backups/forges/<world>/<time>/`;
the forge is stopped for the copy). Homes need none: the VPS copy is the backup. `SLOPSWARM_BACKUP_KEEP` copies are
kept (default 7). Offsite: optional (`rsync` `/var/lib/slopswarm/backups` elsewhere).

Accepted gap: an active world's forge has no backup until its run ends.

Restore the DB: `docker compose -f /opt/slopswarm/compose.yaml stop controller`; copy the backup over
`/var/lib/slopswarm/swarm.db` (remove `swarm.db-wal`/`-shm`); start it. Restore a forge: with its world idle, stop the
forge (`docker rm -f slopswarm-forge-<world> slopswarm-forge-<world>-port`), replace
`/var/lib/slopswarm/worlds/<world>/forge` with the backup copy (`chown -R 1000:1000`), restart the controller.

## 8. Forgejo upgrades

Once the forge faces the internet, bump the pinned image on each Forgejo security release:

1. Set `forge.image` in the presets (`just config` / the dashboard) for new worlds.
2. Upgrade existing worlds: `just forge-upgrade <world> codeberg.org/forgejo/forgejo:<new>-rootless`. The forge
   restarts on the new image and Forgejo runs its migrations. A world keeps its image when a run continues it (the
   preset's image only applies to new worlds), so upgrade a world with an active run once that run ends.
3. Back up first (`just backup <world>`): Forgejo does not migrate down.

## 9. The public read-only forge (§7)

1. Rotate every model key first (README "Credentials and rotation") and apply pending Forgejo security releases.
2. DNS: an A/AAAA record for the domain and a wildcard `*.<domain>` to the VPS's public address.
3. In `/etc/slopswarm/slopswarm.env`: `PUBLIC_FORGE_DOMAIN=<domain>` and `ACME_EMAIL=…`; open 80/443; redeploy (the
   deploy adds the `public` compose profile: Caddy). The new controller starts every world's forge with
   `ROOT_URL=https://<world>.<domain>/`; agents' git maps that URL back to the internal forge (`insteadOf`).
4. Check: `https://<domain>/` lists the worlds; a world's repo page loads without a login; `curl -X POST` anything but
   `…/git-upload-pack` gets 405; `/user/login` gets 404. Over the tailnet you (admin) still see private repos; there the
   forge shows Forgejo's "configured to be served on" notice, because you aren't on the public URL.

Caddy serves `<world>.<domain>` and an index at the apex, with certificates on demand (only names the controller
confirms). Only GET/HEAD (and `POST …/git-upload-pack` for anonymous clones); `/user/*` except avatars, `/admin*`,
`/api/v1/admin*` and archive downloads refused; `Authorization` and `Cookie` stripped; per-client rate limits in the
controller's proxy. Private repos stay private (you see them over the tailnet as admin). The domain is unlisted: keep
it out of the repo, CI logs and committed config; agents see it as `ROOT_URL`.
