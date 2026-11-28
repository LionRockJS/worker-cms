# Self-host on a Raspberry Pi (Ubuntu)

This sets up a Raspberry Pi running Ubuntu Server to serve the CMS on the local
network at `https://cms.local`. The CMS runs in Docker from the published image
`ghcr.io/lionrockjs/0xcms`, behind nginx on the host, which terminates HTTPS
with a self-signed certificate.

Tested on a Raspberry Pi 4 (8 GB) with Ubuntu 26.10. Ubuntu's Raspberry Pi
kernel uses 48-bit virtual addresses, which workerd needs. Raspberry Pi OS
kernels for the Pi 4 use 39-bit addresses, and workerd aborts on them with
"TCMalloc assumes a 48-bit virtual address space", inside Docker too.

Run every command on the Pi as the user you sign in with, unless it says
otherwise.

## 1. First boot

The first boot runs cloud-init. The Wi-Fi settings take effect on the second
boot.

The CMS is reached as `<hostname>.local`, so set the hostname to `cms` (or
check it with `hostnamectl`) if you want `cms.local`.

## 2. Packages

```bash
sudo apt update && sudo apt install -y nginx avahi-daemon docker.io docker-compose-v2
sudo systemctl enable --now avahi-daemon
sudo usermod -aG docker "$USER"
```

Avahi announces `<hostname>.local` on the network. Log out and back in after
`usermod`; until then `docker` fails with "permission denied".

Node is not needed on the Pi: the image brings its own. Install it only to run
repository tools there, such as `npm run apple:client-secret`.

## 3. Start Docker after the clock is set

The Pi has no battery-backed clock, so it boots with a stale date until chrony
corrects it, about a minute after boot. Without this, the CMS starts with the
wrong time: sessions issued then are already expired once the clock jumps, and
early audit entries carry the wrong date.

```bash
sudo systemctl enable chrony-wait.service
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nWants=time-sync.target\nAfter=time-sync.target\n' | sudo tee /etc/systemd/system/docker.service.d/wait-for-time.conf
sudo systemctl daemon-reload
```

`chrony-wait` gives up after three minutes, so with no network Docker still
starts, later.

## 4. Deployment files

The image comes from the registry. The checkout provides `compose.yaml`, the
nginx site and the settings template.

```bash
git clone --branch development https://github.com/LionRockJS/worker-cms.git ~/worker-cms
cd ~/worker-cms
```

## 5. Settings

```bash
cd ~/worker-cms
echo "BASE_URL=https://cms.local" > .env
cp cms.env.example cms.env && chmod 600 cms.env
sed -i "s/^JWT_SECRET=$/JWT_SECRET=$(openssl rand -hex 32)/" cms.env
nano cms.env
```

`.env` holds `BASE_URL`, the origin browsers use. It must be `https`: the
server refuses a plain-`http` origin other than localhost, and the session
cookies are `Secure`. `cms.env` holds the secrets and settings passed to the
CMS; both files are gitignored and neither is part of the image.

In `cms.env`, uncomment `ENABLED_PROVIDERS` and the lines for your OAuth
provider, and register `https://cms.local/auth/callback` with it. GitHub and
Microsoft accept a `.local` callback; Google and Apple require a public domain
(see [Public address with a Cloudflare Tunnel](#public-address-with-a-cloudflare-tunnel)).
The comments in `cms.env.example` link to each provider's registration page.

## 6. HTTPS and nginx

```bash
sudo openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
  -subj "/CN=cms.local" -addext "subjectAltName=DNS:cms.local" \
  -addext "extendedKeyUsage=serverAuth" -addext "keyUsage=digitalSignature" \
  -keyout /etc/ssl/private/cms.local.key -out /etc/ssl/certs/cms.local.crt
sudo chmod 600 /etc/ssl/private/cms.local.key
sudo cp ~/worker-cms/docker/nginx/cms.conf /etc/nginx/sites-available/cms.conf
sudo ln -s ../sites-available/cms.conf /etc/nginx/sites-enabled/cms.conf
sudo nginx -t && sudo systemctl reload nginx
```

825 days is the longest validity macOS accepts; renew the certificate before
it expires. The nginx site redirects http to https, forwards websockets (the
page editor uses them), allows 30 MB uploads, and sets `CF-Connecting-IP` to
the client's address, which the rate limits and audit log rely on.
`compose.yaml` publishes the CMS on `127.0.0.1:8787` only, so nginx is the
only way in. For another hostname, change `server_name`, the redirect and the
certificate paths in the site file.

## 7. Start the CMS

```bash
cd ~/worker-cms
docker compose pull
docker compose up -d
docker compose logs -f cms
```

Wait for `served as https://cms.local`, then press Ctrl-C; the CMS keeps
running. Each start applies any pending database migrations first. To check
the site through nginx:

```bash
curl -sk --resolve cms.local:443:127.0.0.1 -o /dev/null -w "%{http_code}\n" https://cms.local/auth/login
```

`200` means it works.

## 8. First admin

New accounts start as viewers. Sign in once at `https://cms.local`, then
promote that first account:

```bash
cd ~/worker-cms
docker compose exec cms node_modules/.bin/wrangler d1 execute DB --local \
  --command "UPDATE users SET role='admin' WHERE id=1 RETURNING id, role"
```

Sign out and back in to pick up the role. `INITIAL_USER_ROLES` in `cms.env`
grants roles at first sign-in instead, but only for an ID or verified email
you already know; for Microsoft the ID is the account's OAuth `sub`, not the
Object ID shown in Entra. See README "7. Set the first user's role".

## 9. Trust the certificate

Each computer that opens the CMS warns about the self-signed certificate until
it trusts it. On a Mac:

```bash
scp <user>@cms.local:/etc/ssl/certs/cms.local.crt ~/Downloads/
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/cms.local.crt
```

## 10. Scheduled jobs

Two cron jobs, both run as your user: a database snapshot every night at 03:00
(the Pi's local time) and a memory check every 5 minutes. See
[Nightly snapshots](#nightly-snapshots) and [Memory](#memory) for what they do.

```bash
(crontab -l 2>/dev/null | grep -v -e d1-snapshot.sh -e memory-check.sh
 echo '0 3 * * * sh "$HOME/worker-cms/docker/d1-snapshot.sh" >> "$HOME/cms-snapshots.log" 2>&1'
 echo '*/5 * * * * sh "$HOME/worker-cms/docker/memory-check.sh" >> "$HOME/cms-memory.log" 2>&1') | crontab -
crontab -l
```

This keeps any other cron jobs and can be run again safely. Don't run it under
`set -e`: with an empty crontab, `grep` finds nothing and would stop the list
before the two jobs are added.

## Public address with a Cloudflare Tunnel

`cms.local` exists only on your network. Anything outside it cannot reach the
CMS, notably plugins deployed to Cloudflare: connecting one (Admin → Plugins →
Connect) makes the plugin call back to the CMS to collect its secret, and it
keeps calling the CMS afterwards. With a `.local` address that fails with "The
plugin refused the enrollment". A Cloudflare Tunnel gives the Pi a public
HTTPS address, for example `cms.example.com`, without opening a port on your
router. You need a domain on Cloudflare.

Install `cloudflared` on the Pi from Cloudflare's package repository, so
`apt upgrade` keeps it current:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg | sudo tee /usr/share/keyrings/cloudflare-public-v2.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

Create the tunnel on a computer with a browser and `cloudflared` installed
(`brew install cloudflared` on a Mac). `login` opens Cloudflare; choose the
domain the address belongs to:

```bash
cloudflared tunnel login
cloudflared tunnel create cms-pi
cloudflared tunnel route dns cms-pi cms.example.com
```

`create` prints the tunnel ID and writes `~/.cloudflared/<tunnel-id>.json`.
That file lets whoever holds it run the tunnel; keep it secret. Copy it to the
Pi with `scp ~/.cloudflared/<tunnel-id>.json <user>@cms.local:`, then on the
Pi:

```bash
sudo mkdir -p /etc/cloudflared
sudo mv ~/<tunnel-id>.json /etc/cloudflared/ && sudo chmod 600 /etc/cloudflared/<tunnel-id>.json
sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json

ingress:
  - hostname: cms.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
EOF
sudo cloudflared service install
systemctl status cloudflared --no-pager
```

The service is enabled at boot and restarts itself if it stops. It forwards to
the CMS directly rather than through nginx; Cloudflare's edge sets
`CF-Connecting-IP` to the visitor's address. Use `127.0.0.1`, not `localhost`:
`localhost` makes cloudflared try `::1` first, where nothing listens.

Then make the public address the CMS's own:

```bash
cd ~/worker-cms
sed -i 's|^BASE_URL=.*|BASE_URL=https://cms.example.com|' .env
docker compose up -d
```

Register `https://cms.example.com/auth/callback` with your OAuth provider, and
work at the new address from then on. `cms.local` still loads pages, because
the server treats every request as one for `BASE_URL`, but signing in returns
you to the new address, and forms submitted from a `cms.local` page are refused
with 403 because their `Origin` no longer matches. To check from any computer:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://cms.example.com/auth/login
```

## Updating

Each push to `development` that passes CI publishes a new `:development`
image, and each merge into `main` a new `:latest`
(`.github/workflows/docker.yml`). The Pi follows `:development` and updates
only when told to:

```bash
sh ~/worker-cms/docker/update.sh
```

It pulls the checkout and the image, recreates the container only if the image
changed, waits until the CMS answers, removes the replaced image, and prints
the commits it moved between, for example `df941b6 -> 8c7779d`. If the CMS does
not answer within two minutes, it prints the recent log and the tag to go back
to.

To follow `main` instead, set `CMS_TAG=latest` in `.env`; to pin an exact
build, set `CMS_TAG=sha-<commit>`. Then run the update script, or
`docker compose up -d` if the image is already pulled. `docker compose up -d --build` builds the image from
the checkout instead of pulling it.

## Backup

All CMS data (databases, uploads, sessions) is in the Docker volume
`worker-cms_cms-state`; the image holds none of it. Stop the CMS so the
databases are copied in a consistent state:

```bash
cd ~/worker-cms
docker compose stop
docker run --rm -u "$(id -u):$(id -g)" -v worker-cms_cms-state:/data:ro -v "$PWD":/backup busybox tar czf /backup/cms-state-$(date +%F).tar.gz -C /data .
docker compose start
```

`-u` makes the archive yours rather than root's. It reads the volume as your
user, which works because the data belongs to uid 1000: the container's `node`
user and the first user Ubuntu creates. Keep `cms.env` with the backup. Losing `JWT_SECRET` signs everyone out but
loses no data.

## Read the databases without stopping the CMS

Each D1 database is a SQLite file in WAL mode inside the data volume, so it
can be read while the CMS writes to it. For a quick query, run Wrangler in the
CMS container:

```bash
cd ~/worker-cms
docker compose exec cms node_modules/.bin/wrangler d1 execute DB --local \
  --command "SELECT id, email, role FROM users"
```

`DB` is the CMS database; `PUBLISHED_DB` holds published content. This runs
any SQL, writes included, so mind what you send.

To open the data in another SQLite tool, `docker/d1-snapshot.mjs` writes a
consistent copy of each database (`VACUUM INTO` on a read-only connection),
from a throwaway container that mounts the same volume:

```bash
mkdir -p ~/cms-snapshot && cd ~/cms-snapshot
docker run --rm -u "$(id -u):$(id -g)" \
  -v worker-cms_cms-state:/data -v "$PWD":/out -v ~/worker-cms/docker:/tools:ro \
  --entrypoint node ghcr.io/lionrockjs/0xcms:development /tools/d1-snapshot.mjs
```

It writes `cms.sqlite` and `cms-published.sqlite`, overwriting earlier copies.
Copy them to another computer with
`scp '<user>@cms.local:cms-snapshot/*.sqlite' .`. Changes to the copies stay
in the copies. Never write to the live files from outside the CMS; make
changes with the Wrangler command above.

### Nightly snapshots

`docker/d1-snapshot.sh` wraps the same snapshot for cron. Each run adds a
folder `~/cms-snapshots/<YYYY-MM-DD_HHMM>/` and deletes snapshot folders older
than 30 days. It uses the running CMS's own image and volume, so it needs no
arguments. [Step 10](#10-scheduled-jobs) runs it every night at 03:00.

Each run appends one line to `~/cms-snapshots.log`. To change the defaults,
pass a folder and a number of days in the crontab line (`crontab -e`), for
example `d1-snapshot.sh /mnt/usb/cms 90`. These snapshots
cover the databases only; uploaded media is in the volume too and needs the
full backup above.

## Memory

The CMS normally uses 300–350 MiB, about 220 MiB of it a Node process that
runs Miniflare beside workerd. To drop that, set `CMS_RUNTIME=workerd` in
`.env` and run `docker compose up -d`: Node then only writes a standalone
workerd config and exits, and the container idles at about 80 MiB. Media
previews are resized by a small Node thumbnail service (`docker/resize.mjs`,
15–25 MiB) in place of Miniflare's Images binding. See README "Runtime".

Two limits guard against growth:

- `docker/memory-check.sh` restarts the CMS's workerd runtime once the
  container uses 720 MiB, but not within 15 minutes of the last start or
  restart. It sends `SIGUSR2`, and `server.mjs` swaps in a fresh workerd
  process while the container and the Node process keep running: the CMS
  serves again in about 3 seconds, where a container restart takes about 45 on
  a Pi 4 (it reruns the migrations and reloads Wrangler). Requests in flight
  during those seconds fail; stored data is unaffected. The script measures
  memory the way `docker stats` does and prints only when it acts.
- `mem_limit` in `compose.yaml` is a hard cap, 1 GiB by default: past it the
  kernel kills the CMS and Docker starts the container again. It catches
  growth between checks, and growth in the Node process, which a workerd
  restart does not free. Set `CMS_MEMORY_LIMIT` in `.env` to change it, for
  example `1500m`.

[Step 10](#10-scheduled-jobs) runs the check every 5 minutes. To change the
threshold, pass it in MiB in the crontab line (`crontab -e`), for example
`memory-check.sh 900`, and keep it below `CMS_MEMORY_LIMIT`. `~/cms-memory.log` lists each restart with
the memory use before it and 10 seconds after. To restart the runtime by hand:
`docker compose kill -s SIGUSR2 cms`.

## Troubleshooting

- **workerd aborts with "TCMalloc assumes a 48-bit virtual address space"**:
  the kernel uses 39-bit addresses. Check with
  `grep VA_BITS /boot/config-$(uname -r)`; it needs `CONFIG_ARM64_VA_BITS_48=y`.
- **`git pull` or `docker compose pull` fails with a certificate error right
  after boot**: the clock has not been corrected yet. `timedatectl` shows
  `System clock synchronized: no` until it is.
- **`cms.local` redirects to another address**: `BASE_URL` in `.env` does not
  match the address you opened. The CMS redirects every other host to it.
- **502 Bad Gateway for about a minute and a half after boot**: Docker waits
  for the clock, then the CMS takes a while to start. Until it listens, nginx
  and the tunnel get their connections refused or reset. It clears by itself.
- **Connecting a plugin says "The plugin refused the enrollment"**: the plugin
  cannot reach `BASE_URL`. A Cloudflare-hosted plugin needs a public address;
  see [Public address with a Cloudflare Tunnel](#public-address-with-a-cloudflare-tunnel).
