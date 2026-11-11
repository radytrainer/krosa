# Free managed PostgreSQL and Redis for a 6–12 month Krosa test deployment (as of November 2026)

Context: Krosa needs PostgreSQL 15+ (ideally 17) via Prisma 7 with migrations and custom SQL functions
(`ssrs_apply_term_defaults`), under 500 MB, 50–100 users; and Redis for BullMQ (persistent TCP,
blocking commands, Lua, `maxmemory-policy noeviction`). Users in Cambodia, so Singapore is preferred.
Research done 2026-11-05 from official pricing/docs pages, using about 15 tool calls; several providers
in the brief (Xata, Koyeb, Railway, Nile, CockroachDB, Render Key Value memory size) could not be
checked in that budget and are listed under Gaps.

## PostgreSQL: which free tiers last 6–12 months without expiring, and with what limits?

### Takeaway

**Neon Free is the strongest fit**: Singapore region, 0.5 GB+ headroom (1 GB per project), no
inactivity pause or deletion, no card, with scale-to-zero after 5 minutes (cold starts) and 100
CU-hours/month as the main limits. **Prisma Postgres Free** (Postgres 17, Singapore, 2 GB) is a good
second, but its 200K operations/month and 10 connections are tight. **Supabase Free** works only if
something keeps it active (it pauses after 1 week idle) and has no backups. **Render Free Postgres
is unsuitable** (expires after 30 days, deleted 14 days later). **Aiven Free** is indefinite but may be
powered off when inactive and its exact limits are not published on the pages read.

### Cited Findings

**Neon (Free plan)**

- 1 GB storage per project, 20 GB across all projects; 100 projects; 10 branches per project — [Neon pricing](https://neon.com/pricing)
- 100 CU-hours per project per month; autoscaling up to 2 CU (8 GB RAM) — [Neon pricing](https://neon.com/pricing)
- Scale to zero after 5 minutes of inactivity; cannot be turned off on Free — [Neon pricing](https://neon.com/pricing)
- Point-in-time history window 6 hours (1 GB limit); 1 manual snapshot — [Neon pricing](https://neon.com/pricing)
- 5 GB egress per project per month — [Neon pricing](https://neon.com/pricing)
- No credit card needed; "Free projects aren't paused or deleted for inactivity" — [Neon pricing](https://neon.com/pricing)
- On hitting limits: running out of CU-hours or egress suspends compute until the next billing period; exceeding storage blocks writes; no data is deleted — [Neon pricing](https://neon.com/pricing)
- Pricing page lists 10,000 pooled connections per compute (stated for all plans, not specifically Free) — [Neon pricing](https://neon.com/pricing)
- Regions: 8 AWS regions including `aws-ap-southeast-1` (Singapore), which supports every Neon product; Azure regions are deprecated for new projects — [Neon regions](https://neon.com/docs/introduction/regions)

**Supabase (Free plan)**

- 500 MB database per project, shared CPU, 500 MB RAM; two active projects — [Supabase pricing](https://supabase.com/pricing)
- "Free projects are paused after one week of inactivity" — [Supabase pricing](https://supabase.com/pricing)
- No automatic backups and no point-in-time recovery on Free — [Supabase pricing](https://supabase.com/pricing)
- 5 GB egress (+5 GB cached egress); 1-day log retention — [Supabase pricing](https://supabase.com/pricing)
- Direct connection (`db.[ref].supabase.co:5432`) is **IPv6 only** on Free unless the paid IPv4 add-on is bought; IPv4-only networks must use the shared pooler in session mode (port 5432) or transaction mode (port 6543) — [Supabase connecting docs](https://supabase.com/docs/guides/database/connecting-to-postgres)
- Migrations should use a direct (or session) connection; for runtime queries in transaction mode Prisma needs `pgbouncer=true` — [Supabase connecting docs](https://supabase.com/docs/guides/database/connecting-to-postgres)
- Free plan connection limits and card requirement are not stated on the pricing page — [Supabase pricing](https://supabase.com/pricing)

**Prisma Postgres (Free plan)**

- 50 databases, 200,000 operations per month (each query = 1 operation), 2 GB storage — [Prisma pricing](https://www.prisma.io/pricing)
- 10 pooled and 10 direct connections; idle connections time out after 60 minutes; pool mode is transaction; pooled queries capped at 10 minutes, direct connections unlimited — [Prisma pricing](https://www.prisma.io/pricing)
- No backups on Free (daily backups start on Starter); no credit card; "Free forever", spend limit fixed at $0 — [Prisma pricing](https://www.prisma.io/pricing)
- Regions include `ap-southeast-1` (Singapore), plus us-west-1, us-east-1, eu-west-3, eu-central-1, ap-northeast-1 — [Prisma Postgres FAQ](https://www.prisma.io/docs/postgres/faq.md)
- Runs PostgreSQL 17 (an older Early Access page said 16; treat that as outdated) — [Prisma Postgres docs](https://docs.prisma.io/docs/postgres)

**Aiven (Free tier)**

- PostgreSQL free: 1 GB RAM, 1 GB storage; automated backups included (no retention given); no credit card — [Aiven free tier](https://aiven.io/free-tier)
- One free service per service type per account (one free PostgreSQL and one free Valkey can coexist) — [Aiven free tier](https://aiven.io/free-tier)
- "Free services do not have any time limitations", but Aiven may power off a free service with no initial use in the first few hours or no ongoing activity (notification sent first; no day count given); Aiven may change cloud, region or configuration at any time — [Aiven free plan docs](https://aiven.io/docs/platform/concepts/free-plan)
- Connection limits, regions and Postgres version for Free are not stated; for comparison the paid Developer tier has `max_connections` 20 and is not powered off when idle — [Aiven free plan docs](https://aiven.io/docs/platform/concepts/free-plan)

**Render (Free Postgres)**

- 1 GB storage; free databases "expire 30 days after creation"; 14-day grace period, then the database and all data are deleted — [Render free docs](https://render.com/docs/free)
- No backups, no managed connection pooling, one free database per workspace, may be restarted at any time — [Render free docs](https://render.com/docs/free)

### Inferences

- For a 6–12 month test, Render is out (would need re-creation every month with data migration).
- Neon: Krosa's data (<500 MB) fits 1 GB. 100 CU-hours/month at 0.25 CU minimum would be roughly 400 hours of active compute, so it lasts only if the database actually scales to zero. **An always-on API or worker that queries Postgres periodically (health checks, polling, BullMQ job handlers touching Postgres) would keep compute awake and could exhaust CU-hours mid-month**, suspending the database. Keep health checks off the database and avoid periodic DB queries. Cold start after 5 minutes idle adds latency to the first request.
- Neon/Prisma 7: use the pooled URL for the app and the direct (non-pooler) URL for `prisma migrate deploy`, set in `prisma.config.ts` (Prisma 7 moved `url`/`directUrl` out of the schema). Custom SQL functions in migrations need a direct session connection, not a transaction pooler.
- Prisma Postgres: 200K ops/month is about 6,600 queries/day. A sync that upserts many marks per term, plus polling, could exceed that; verify by counting queries per sync before choosing it. No backups.
- Supabase: the 7-day pause matters for a test with quiet weeks; a scheduled ping keeps it alive but that is a workaround, and there are no backups. Krosa's API servers on IPv4-only hosts must use the pooler host, not the direct host.
- Backups: none of the free tiers above give real backups except Aiven (unspecified) and Neon's 6-hour history plus 1 snapshot. Plan a scheduled `pg_dump` to storage regardless of provider.

### Gaps

- Xata, Koyeb, Railway, Nile and CockroachDB free tiers were not researched in this pass (tool budget). From prior knowledge only, not verified for Nov 2026: Railway has no permanent free tier (trial credit only); CockroachDB is wire-compatible but not fully Postgres-compatible (PL/pgSQL functions and some DDL differ), so `ssrs_apply_term_defaults` and Prisma migrations may need changes — treat CockroachDB as a poor fit unless verified.
- Neon Free connection limit per compute and default Postgres version (Neon supports 14–17 historically; 17 is likely default) not confirmed from a page read.
- Supabase default Postgres version for new projects (believed 17) not confirmed; card requirement not stated.
- Aiven free: regions (whether Singapore is offered), connection limit, Postgres version, inactivity threshold in days.
- Prisma Postgres inactivity policy not stated on the pricing page.

## Redis for BullMQ: which free tiers work reliably without eviction, and how fast does an idle worker burn commands?

### Takeaway

**No free Redis tier is a clean fit.** Upstash Free (500K commands/month) will likely be exceeded by an
idle BullMQ worker at default settings (inference: roughly 20K+ commands/day ≈ 600K+/month); it works
only with much longer `drainDelay`/`stalledInterval`, and Upstash itself recommends a fixed paid plan
for BullMQ. **Redis Cloud Free (30 MB, 30 connections, 100 ops/sec)** has no command quota and suits
BullMQ's command pattern better, but has no backups and a reported inactivity deletion rule.
**Render Free Key Value loses all data on restart.** **Aiven Free Valkey** (1 GB RAM) is plausible but
its eviction policy and inactivity power-off need checking. Running Redis in the same container/VM as
the worker may be more reliable than any free managed option.

### Cited Findings

**BullMQ requirements**

- Redis must use `maxmemory-policy=noeviction`; it is "the only setting that guarantees the correct behavior of the queues" — [BullMQ going to production](https://docs.bullmq.io/guide/going-to-production); also warned in [BullMQ connections](https://docs.bullmq.io/guide/connections)
- Persistence must be set up explicitly (many hosts don't enable it); AOF with ~1 s fsync recommended — [BullMQ going to production](https://docs.bullmq.io/guide/going-to-production)
- Workers need `maxRetriesPerRequest: null` (BullMQ throws otherwise when an ioredis client is passed); disable `enableOfflineQueue` on Queue instances, keep it on Workers — [BullMQ connections](https://docs.bullmq.io/guide/connections), [BullMQ going to production](https://docs.bullmq.io/guide/going-to-production)
- Worker `drainDelay` default is 5 seconds (long-poll time when the queue is empty); `stalledInterval` default 30,000 ms — [BullMQ WorkerOptions API](https://api.docs.bullmq.io/interfaces/v5.WorkerOptions.html)
- BullMQ docs do not mention Upstash or give idle command counts — [BullMQ connections](https://docs.bullmq.io/guide/connections)

**Upstash Redis (Free)**

- 500K commands per month, 250 MB data, 10 GB bandwidth/month, 10,000 commands/sec max, 1 database; AWS, GCP, Vercel platforms — [Upstash pricing](https://upstash.com/pricing/redis)
- Pay-as-you-go: $0.20 per 100K commands — [Upstash pricing](https://upstash.com/pricing/redis)
- Upstash on BullMQ: "BullMQ accesses Redis regularly, even when there is no queue activity"; "we recommend switching to a Fixed plan to avoid increased command count and high costs in BullMQ use cases"; connection uses port 6379 with `tls: {}` — [Upstash BullMQ integration](https://upstash.com/docs/redis/integrations/bullmq)
- Eviction is disabled by default; with eviction off, writes are rejected at the max data size — [Upstash eviction](https://upstash.com/docs/redis/features/eviction)
- Free databases are archived after at least 30 days of inactivity, with warning emails; Upstash keeps a backup that can be restored into a new database — [Upstash FAQ](https://upstash.com/docs/redis/help/faq)
- Databases created anonymously via `/start-redis` are deleted after 3 days unless claimed — [Upstash pricing](https://upstash.com/pricing/redis)
- A third-party NestJS guide claims default BullMQ settings burn huge command counts on Upstash; its numbers (5 ms default drainDelay, 570M/day) contradict the official 5 s default and should not be trusted — [skills.sh guide](https://www.skills.sh/hoangnguyen0403/agent-skills-standard/nestjs-bullmq)

**Redis Cloud (Free 30 MB Essentials)**

- 30 MB, single database, one free database per account, AWS/Azure/GCP; "Always $0", community support, best-effort SLA — [Redis pricing](https://redis.io/pricing/), [Redis Cloud quick start](https://redis.io/docs/latest/operate/rc/rc-quickstart/)
- Free plan limits (current plans, updated December 2025): 30 concurrent connections, 1 CIDR allow rule, 5 GB monthly bandwidth, 100 ops/sec max throughput; high availability and backups are paid-only (paid plans start at 250 MB) — [Redis Cloud Essentials plans](https://redis.io/docs/latest/operate/rc/subscriptions/view-essentials-subscription/essentials-plan-details/)
- Free sign-up path creates the database without a payment step in the quick start (the card step appears only for paid Essentials) — [Redis Cloud quick start](https://redis.io/docs/latest/operate/rc/rc-quickstart/), [Create Essentials DB](https://redis.io/docs/latest/operate/rc/databases/create-database/create-essentials-database/)
- A search summary cited a Redis support article saying free databases are deleted after 14 days of inactivity with no backups — [Redis support article](https://support.redislabs.com/hc/en-us/articles/33138489404818) (not read directly; unverified)

**Aiven Valkey (Free)**

- 1 GB RAM; no credit card; one free Valkey per account alongside one free PostgreSQL; same inactivity power-off and "may change region/config" terms as other Aiven free services — [Aiven free tier](https://aiven.io/free-tier), [Aiven free plan docs](https://aiven.io/docs/platform/concepts/free-plan)

**Render Key Value (Free)**

- In-memory only; "a restart erases all data"; may be restarted for maintenance at any time; upgrading to paid also erases data; one free instance per workspace — [Render free docs](https://render.com/docs/free)

### Inferences

- **Idle BullMQ command estimate (one worker, one queue, BullMQ v5 defaults; my estimate, not measured):**
  - Blocking wait on the marker key times out every `drainDelay` = 5 s → ~17,280 blocking calls/day, each typically followed by a move-to-active Lua attempt → ~17K–35K/day.
  - Stalled-job check Lua script every 30 s → ~2,880/day.
  - Total ≈ **20,000–40,000 commands/day ≈ 0.6–1.2M/month per worker per queue**, above Upstash Free's 500K/month. Each extra queue or worker multiplies this; `QueueEvents` listeners add their own blocking `XREAD` loop.
  - With `drainDelay: 300` (s) and `stalledInterval: 300000` (ms): roughly 288 + 288 wake-ups plus scripts ≈ 1–2K/day ≈ 30–60K/month, which fits Upstash Free. The cost is up to a 5-minute delay picking up a job only if the marker wake-up is missed; BullMQ normally wakes the blocked worker immediately when a job is added, so latency should stay low — verify in testing.
  - Measure real usage in the provider dashboard before trusting these figures.
- Redis Cloud Free: the 100 ops/sec cap is fine for an idle worker and occasional syncs, 30 connections are enough (BullMQ uses ~2–3 connections per Worker/Queue/QueueEvents), and 30 MB is enough if completed/failed jobs are trimmed (`removeOnComplete`/`removeOnFail`). The eviction policy on Redis Cloud is configurable per database; it must be set to `noeviction` (the default on Redis Cloud may be `volatile-lru` — check at creation).
- Render Key Value: losing all job state on any restart makes it unsuitable even for testing BullMQ reliably.
- For Krosa a lost queue is recoverable (syncs can be re-triggered and Postgres is the source of truth), so a non-persistent Redis is tolerable for a test, but eviction is not (BullMQ breaks silently).
- A practical alternative: run Redis/Valkey as a sidecar container on the same free or cheap VM that runs the worker, if the compute host allows it; this avoids command quotas and inactivity deletion.

### Gaps

- Upstash Free regions (whether Singapore `ap-southeast-1` is offered on Free) and max connections not confirmed from a page read (prior knowledge: Upstash offers AWS Singapore; connection cap on Free historically around 10,000 — unverified).
- Redis Cloud Free: default eviction policy, persistence availability on Free, Singapore region availability for the free plan, and the 14-day inactivity rule were not confirmed from primary pages.
- Aiven Valkey Free: storage/persistence, eviction policy configurability, connection limit, regions.
- Render Key Value Free memory size (prior knowledge: 25 MB) and eviction policy not confirmed.
- Railway Redis: no permanent free tier per prior knowledge; not verified.
- No primary measurement of BullMQ idle command usage was found; the estimate above is derived from documented defaults.

## Gotchas: inactivity pausing, deletion, IP allowlists, TLS, credit cards

### Takeaway

The main traps are Supabase's 7-day pause, Render's 30-day expiry, Upstash's 30-day-idle archive,
Redis Cloud's reported idle deletion and 1-CIDR allowlist, Aiven's unspecified idle power-off, Neon's
compute-hour suspension, and Supabase's IPv6-only direct host. None of the free tiers checked require
a credit card (Neon, Prisma, Aiven explicitly; Redis Cloud free path shows no card step).

### Cited Findings

- Neon: never paused or deleted for inactivity; compute suspended if CU-hours or egress run out — [Neon pricing](https://neon.com/pricing)
- Supabase: paused after 1 week inactivity; direct host IPv6-only on Free — [Supabase pricing](https://supabase.com/pricing), [Supabase connecting docs](https://supabase.com/docs/guides/database/connecting-to-postgres)
- Render: Postgres expires at 30 days, deleted after 14 more; Key Value data lost on restart — [Render free docs](https://render.com/docs/free)
- Aiven: idle free services may be powered off (after notice); region/config may change — [Aiven free plan docs](https://aiven.io/docs/platform/concepts/free-plan)
- Upstash: free DB archived after 30+ days inactivity (backup kept); TLS required in the BullMQ example (`tls: {}`, i.e. `rediss://`) — [Upstash FAQ](https://upstash.com/docs/redis/help/faq), [Upstash BullMQ](https://upstash.com/docs/redis/integrations/bullmq)
- Redis Cloud Free: 1 CIDR allow rule only — [Redis Cloud Essentials plans](https://redis.io/docs/latest/operate/rc/subscriptions/view-essentials-subscription/essentials-plan-details/)
- Prisma Postgres: idle connections closed after 60 minutes — [Prisma pricing](https://www.prisma.io/pricing)
- No credit card: Neon, Prisma Postgres, Aiven — [Neon pricing](https://neon.com/pricing), [Prisma pricing](https://www.prisma.io/pricing), [Aiven free tier](https://aiven.io/free-tier)

### Inferences

- An active BullMQ worker counts as "activity" for Upstash/Redis Cloud, so inactivity deletion of Redis is unlikely while the worker runs; but the same activity is what burns Upstash's command quota.
- With only 1 CIDR rule on Redis Cloud Free, a host with changing egress IPs (most free PaaS) cannot be allowlisted; leave the allowlist open and rely on password + TLS.
- Use `rediss://` URLs and `tls: {}` for Upstash; ensure the ioredis connection in `apps/worker` and `apps/api` accepts a TLS URL from env.
- Neon cold starts plus Prisma's default connect timeout can cause the first request after idle to fail; raise `connect_timeout` in the connection string.

### Gaps

- Whether Supabase requires a card at sign-up, and Supabase's exact inactivity definition (API requests vs DB queries).
- Exact TLS requirements for Redis Cloud Free and Aiven Valkey (Aiven services generally require TLS — unverified).
