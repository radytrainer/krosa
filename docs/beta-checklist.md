# Beta server checklist

The steps only you can do, in AWS, GitHub and on the server, in this order. How the setup works:
[deployment.md](deployment.md). Later operation: [runbook.md](runbook.md).

Region: **`ap-southeast-2`** (Sydney); the instance goes in Availability Zone **`ap-southeast-2c`**.
Placeholders: `<BETA_DOMAIN>` (e.g. `krosa-beta.example.org`),
`<INSTANCE_ID>`, `<BUCKET>`, `<ACCOUNT_ID>`. Owner and repository: `radytrainer/krosa`.

Server commands run in a **Session Manager** shell as root: AWS console → Systems Manager → Session
Manager → **Start session** → the instance → `sudo -i`. Never paste a secret as a command
argument; the steps below read secrets without echoing them.

Have ready: the AWS account (root user with MFA, and an admin IAM user or Identity Center user
for daily work), admin access to the GitHub repository, the domain's DNS, the school's password
manager, and [age](https://github.com/FiloSottile/age) on your computer
(`winget install FiloSottile.age`).

## A. Shell access and the old key (do these first)

1. **Session Manager is the only shell.** SSH stays disabled: port 22 is closed in the security
   group and in ufw, and `bootstrap.sh` turns the SSH service off. Emergency access is Session
   Manager; if the SSM agent itself is broken, use EC2 → the instance → **Connect → EC2 serial
   console** (enable it once under EC2 → Settings → EC2 Serial Console).

   Session logging: Systems Manager → Session Manager → **Preferences**. Later steps paste the
   settings file, the Google key and (for restores) the backup key into a session. Leave **S3
   logging** and **CloudWatch logging** off; if your organization requires them, make sure the log
   bucket or group is encrypted and readable only by administrators before step 13.

2. **Launch without a key pair from now on.** In every launch wizard: Key pair → **Proceed without a
   key pair**. Nothing in this setup uses SSH keys.
3. **Delete the EC2 key pair** that was created earlier: EC2 → Network & Security → **Key Pairs** →
   select it → Actions → **Delete**. Delete every local copy of its `.pem` file (Downloads, email,
   chat), and empty the recycle bin. Treat that key as exposed. Deleting the key pair in AWS does
   not remove the key from an instance that was launched with it: step 4 does that.
4. **Remove all keys from the instance** (as soon as Session Manager works, at step 11), as root:

   ```bash
   : > /home/ubuntu/.ssh/authorized_keys
   find /root/.ssh /home/*/.ssh -name authorized_keys -exec sh -c ': > "$1"' _ {} \; 2>/dev/null
   wc -c /home/ubuntu/.ssh/authorized_keys      # 0
   ```

## B. AWS

5. **Region.** Top right of the console → **Asia Pacific (Sydney) `ap-southeast-2`**. Use the same
   region for every step.
6. **Launch the instance.** EC2 → Instances → **Launch instances**:
   - Name `ssrs-beta`; AMI **Ubuntu Server 24.04 LTS (HVM), SSD, 64-bit (x86)**.
   - Instance type **t3.micro**. Key pair: **Proceed without a key pair** (step 2).
   - Network settings → Edit → **Subnet**: the default subnet in **`ap-southeast-2c`** → **Select
     existing security group** → `default` for now (step 11 replaces it). Auto-assign public IP:
     Enable.
   - Storage: **30 GiB gp3**; Advanced → **Encrypted: Yes**, **Delete on termination: No**.
   - Advanced details: **Termination protection: Enable**; **Metadata version: V2 only (token
     required)**; Metadata response hop limit **1**. Leave IAM instance profile empty for now and
     leave User data empty.
   - Launch. Note the instance id (`i-…`) and the VPC id (instance → Networking tab).

   An instance that already exists (launched with a key pair): keep it if it holds nothing you
   need to lose, do step 4 at step 11, and check the settings above (Actions → Instance settings →
   Modify instance metadata options → IMDSv2 Required).

7. **Elastic IP.** EC2 → Network & Security → **Elastic IPs** → Allocate Elastic IP address →
   Allocate → select it → Actions → **Associate** → the instance → Associate.
8. **DNS.** At your DNS provider (or Route 53 → Hosted zones → the domain): an **A record**
   `<BETA_DOMAIN>` → the Elastic IP, TTL 300. Wait until it resolves:
   `nslookup <BETA_DOMAIN>` shows the Elastic IP. Caddy needs it before the first start.
9. **GitHub OIDC subject (repository setting, needed by step 10's role).** The deploy role trusts
   only tokens whose subject names this repository, the `beta` environment and the `beta` branch.
   With the GitHub CLI (`gh auth login` as a repository admin), on your computer:

   ```bash
   gh api -X PUT repos/radytrainer/krosa/actions/oidc/customization/sub \
     -F use_default=false \
     -f 'include_claim_keys[]=repo' -f 'include_claim_keys[]=context' -f 'include_claim_keys[]=ref'
   gh api repos/radytrainer/krosa/actions/oidc/customization/sub   # shows the three keys
   ```

   Deploy tokens then carry `repo:radytrainer/krosa:environment:beta:ref:refs/heads/beta`.

10. **CloudFormation stack** (IAM roles, S3 bucket with lifecycle rules, security group, SSM deploy
    document): CloudFormation → Stacks → **Create stack → With new resources** → Upload a template
    file → [`deploy/aws/beta.yml`](../deploy/aws/beta.yml) → Next. Stack name `ssrs-beta`.
    Parameters:
    - `InstanceId`, `VpcId`: from step 6.
    - `BackupBucketName`: globally unique, e.g. `ssrs-beta-backups-` plus 8 random lower-case
      letters or digits.
    - `CreateOidcProvider`: `true`, unless IAM → Identity providers already lists
      `token.actions.githubusercontent.com` (then `false`).
    - Leave `GitHubOwner`, `GitHubRepo`, `GitHubEnvironment`, `GitHubBranch`, `BackupPrefix` as they
      are.

    Next → tick **I acknowledge that AWS CloudFormation might create IAM resources** → Submit.
    When it shows CREATE_COMPLETE, open **Outputs** and keep `DeployRoleArn`,
    `InstanceProfileName`, `SecurityGroupId`, `BackupBucketName`.

    The bucket is private (Block Public Access), encrypted (SSE-S3), versioned, TLS only, and its
    lifecycle rules keep `beta/daily/` 14 days, `beta/weekly/` 56 days (8 weekly) and old versions
    30 days. Check under S3 → the bucket → Management → Lifecycle rules (three rules).

11. **Attach the role and the security group, then connect.**
    - EC2 → the instance → Actions → Security → **Modify IAM role** → `InstanceProfileName` →
      Update.
    - Actions → Security → **Change security groups** → add `SecurityGroupId`, **remove** every
      other group → Save. Inbound must show only 80 and 443 (TCP) and 443 (UDP).
    - Wait 2–5 minutes, then Systems Manager → **Fleet Manager**: the instance is listed as
      Online. Start a Session Manager session (above). Now do **step 4**.

## C. Server

12. **Bootstrap.** Systems Manager → **Run Command** → Run command → `AWS-RunShellScript` →
    Commands (Run Command uses `sh`, so the script goes into a file and runs with bash):

    ```text
    cat > /root/bootstrap.sh <<'BOOTSTRAP'
    …paste the whole of scripts/server/bootstrap.sh here…
    BOOTSTRAP
    bash /root/bootstrap.sh
    ```

    Targets: choose the instance manually → Execution timeout 1800 → Output options: leave the S3
    bucket off (the console output is enough) → Run. Wait for **Success**; the output ends with
    `bootstrap: done`. If Run Command refuses the size, do the same in a Session Manager shell.
    Safe to run again. It creates no secret and starts nothing.

13. **GHCR read-only token.** GitHub → your avatar → Settings → Developer settings → Personal access
    tokens → **Tokens (classic)** → Generate new token (classic): note `ssrs-beta-pull`, expiration
    one year (put a reminder in your calendar), scope **`read:packages` only** → Generate. GHCR does
    not accept fine-grained tokens. On the server, as root (the token is typed into a hidden prompt,
    so it is never in the command history or the session output):

    ```bash
    read -rsp 'GHCR token: ' T; echo; printf '%s' "$T" | docker login ghcr.io -u <your GitHub user> --password-stdin; unset T
    ```

    It prints `Login Succeeded`. Docker keeps it in `/root/.docker/config.json` (root only). Store
    the token in the password manager, then close the GitHub page. A classic token can read every
    package its owner can see: best create it on a separate GitHub account (a "machine user") that
    only has read access to this repository.

14. **Settings file.** As root:

    ```bash
    install -m 600 -o root -g root /dev/null /opt/ssrs/.env
    nano /opt/ssrs/.env      # paste deploy/.env.beta.example, then fill in:
    ```

    `BETA_DOMAIN`, `ACME_EMAIL`, `IMAGE_PREFIX=ghcr.io/radytrainer/krosa`,
    `BACKUP_BUCKET` (`BackupBucketName`), `AWS_REGION=ap-southeast-2` (already in the template), `SENTRY_DSN` (Sentry → the project →
    Settings → Client Keys), and, after step 25, the two `HEALTHCHECKS_*` URLs. Save, then generate
    the three secrets in place (new values, never copied from a laptop; nothing is printed):

    ```bash
    for v in POSTGRES_PASSWORD REDIS_PASSWORD JWT_ACCESS_SECRET; do
      sed -i "s|^$v=.*|$v=$(openssl rand -hex 32)|" /opt/ssrs/.env
    done
    grep -c '=$' /opt/ssrs/.env      # only the optional empty ones remain
    stat -c '%U %a' /opt/ssrs/.env  # root 600
    ```

    Copy the finished file into the password manager (as a secure note) through the Session
    Manager window, then clear the clipboard.

15. **Google service-account key.** As root, paste the JSON key into the file (the editor shows it
    on your screen only):

    ```bash
    install -m 0440 -o root -g ssrs-secrets /dev/null /opt/ssrs/secrets/google-sa.json
    nano /opt/ssrs/secrets/google-sa.json
    chown root:ssrs-secrets /opt/ssrs/secrets/google-sa.json && chmod 0440 /opt/ssrs/secrets/google-sa.json
    jq -r .client_email /opt/ssrs/secrets/google-sa.json   # the service account's address
    ```

    Share each term sheet with that address (Viewer), as in
    [google-sheets-template.md §8](google-sheets-template.md). Delete the downloaded key from your
    computer once it is in the password manager.

16. **Backup encryption key (age).** On your computer, not on the server, and **outside the
    repository folder** (PowerShell):

    ```powershell
    age-keygen -o "$HOME\ssrs-beta-backup.agekey"
    ```

    It prints `Public key: age1…`. Store the whole `.agekey` file (the **private** key) in the
    password manager, then delete the file. Without it no backup can be restored. On the server:

    ```bash
    echo 'age1…the public key…' > /opt/ssrs/backup/age-recipients.txt
    chmod 644 /opt/ssrs/backup/age-recipients.txt
    ```

    Optional: a second line with a second administrator's public key, so either can restore.

## D. GitHub

17. **GitGuardian.** Install the GitGuardian GitHub app (github.com/apps/gitguardian) on
    `radytrainer/krosa`. Open a test pull request so its check ("GitGuardian Security Checks")
    appears once; step 19 can then require it.
18. **Environment `beta`.** Repository → Settings → **Environments** → New environment → `beta`:
    - **Required reviewers**: you (and a second admin if there is one). Untick **Allow
      administrators to bypass configured protection rules**. With a second reviewer, also tick
      **Prevent self-review** (with only one, it would block you from approving your own deploy).
      Save protection rules.
    - **Deployment branches and tags** → Selected branches and tags → Add rule → `beta`.
    - **Environment secrets** → Add: `AWS_ROLE_ARN` = `DeployRoleArn`; `AWS_REGION` = `ap-southeast-2`;
      `EC2_INSTANCE_ID` = `<INSTANCE_ID>`. Nothing else: no passwords, no AWS keys.
    - Settings → Actions → General → Workflow permissions: **Read repository contents and packages
      permissions** (the workflows ask for more per job where needed).

    **Before step 19:** CI's dependency audit passes with one documented exception (picomatch,
    no fixed release; `pnpm-workspace.yaml`, review by 2026-12-31). If a new high advisory appears,
    every required CI run fails and the first deploy (step 20) cannot start until it is fixed.

    **Known risk to accept or fix before real data:** the app connects to PostgreSQL as the
    database owner, not a restricted role ([security.md §13](security.md),
    [backlog.md](backlog.md)).

19. **Branch protection.** Create `beta` first if it does not exist (step 20). Settings → **Rules →
    Rulesets** → New branch ruleset, one per branch (or one for all three):
    - Target branches: `development`, `beta`, `main`. Enforcement: Active.
    - Restrict deletions; Block force pushes; **Require a pull request before merging** (1 approval
      if there is a second reviewer; otherwise 0).
    - **Require status checks to pass**, add: `Lint, typecheck, unit tests, build, audit`,
      `Integration tests`, `GitGuardian Security Checks`; for `beta` and `main` also
      `End-to-end (Playwright, Chromium)`, `Build images (api)`, `Build images (worker)`,
      `Build images (web)`.
    - Require branches to be up to date before merging.
    - Optional: a `CODEOWNERS` file naming you for `.github/workflows/` and `deploy/`, with "Require
      review from Code Owners" ticked, so changes to the pipeline need your review.

## E. Go live

20. **First deploy.** Merge the pull request that brings this setup into `development`. Then
    create `beta` from `development` (Code → Branches → New branch, source `development`), or open
    a pull request `development` → `beta` and merge it. The push to `beta` runs **Actions → Deploy
    beta**: CI, then three images, then it waits at **Deploy to beta** → **Review deployments** →
    tick `beta` → **Approve and deploy**. It takes 5–10 minutes; the job summary shows the live tag.
    If it fails, the summary and the log say which step ([runbook.md](runbook.md)).
21. **Package visibility.** GitHub → your profile (or the organization) → **Packages**: `krosa-api`,
    `krosa-worker`, `krosa-web` each show **Private**. If one is public: the package → Package
    settings → Danger zone → Change visibility → Private.
22. **First administrator.** On the server, as root (the password is prompted without echo):

    ```bash
    ssrs run --rm --no-deps api node dist/cli/create-admin.js --username registrar --display-name "Registrar"
    ```

    Open `https://<BETA_DOMAIN>` and sign in. One admin account per person; no shared accounts.

23. **Checks.** From your computer:
    - `curl -s https://<BETA_DOMAIN>/health` → `OK`.
    - `curl -sI https://<BETA_DOMAIN>/login` shows `strict-transport-security` and
      `content-security-policy`; `curl -sI http://<BETA_DOMAIN>` redirects to https.
    - `Test-NetConnection <BETA_DOMAIN> -Port 22` (PowerShell) fails; so do 5432 and 6379.
    - On the server: `ssrs ps` (all healthy); `systemctl list-timers 'ssrs-*'` (two timers).
24. **Backup and restore test (once, before any student signs in).** On the server, as root:

    ```bash
    systemctl start ssrs-backup.service && journalctl -u ssrs-backup -n 5 --no-pager   # "OK: s3://…"
    aws s3 ls "s3://<BUCKET>/beta/daily/"                                               # newest file
    install -m 600 /dev/null /dev/shm/age.key && nano /dev/shm/age.key   # paste the private key
    /opt/ssrs/current/bin/restore.sh --identity /dev/shm/age.key --s3-key beta/daily/<newest file>
    ```

    It restores into a new database `ssrs_restore_…` (the live one is not touched), prints row
    counts next to the live ones, shreds `/dev/shm/age.key`, and ends with `RESTORE OK`. Drop the
    copy with the command it prints. Record the date in [operations.md §2](operations.md).

25. **Monitoring.**
    - **Uptime:** [UptimeRobot](https://uptimerobot.com) (free, 5-minute checks) → New monitor →
      Keyword → URL `https://<BETA_DOMAIN>/health` → keyword `OK` exists → alert email.
    - **Backups and disk:** [healthchecks.io](https://healthchecks.io) (free) → two checks:
      `ssrs-beta-backup` (period 1 day, grace 2 hours) and `ssrs-beta-disk` (period 1 hour, grace
      2 hours). Put their ping URLs in `HEALTHCHECKS_BACKUP_URL` and `HEALTHCHECKS_DISK_URL` in
      `/opt/ssrs/.env`. A failed or missing run emails you.
    - **Errors:** Sentry alerts for the api and worker project (web is not covered yet).
26. **Optional, recommended.** CloudWatch → Alarms → Create alarm → EC2 → the instance →
    `StatusCheckFailed_System` ≥ 1 for 2 periods → action **Recover this instance** plus an email
    (SNS). Billing → Budgets → a monthly cost budget with an email alert.

Then tell beta users the address. The first deploy of this release signs every user out once
([runbook.md](runbook.md) "Deploy").
