# Free PaaS / container hosting tiers for Krosa (web + API + worker), as of November 2026

Scope: Next.js 15 web (Node 22, SSR, proxies /api), NestJS API (Dockerfile), BullMQ worker (always-on, consumes Redis, calls Google Sheets API). DB/Redis covered elsewhere; bundled offers noted only. Research done 2026-11-05; about 18 sources checked. Several official pages loaded only partly (Render pricing, Cloud Run pricing, Koyeb pricing), so some exact numbers are marked as gaps.

## Which platforms still have a usable free tier for app containers in Nov 2026, and what are the exact limits?

### Takeaway
Only Render (web services only, sleep after 15 min), Northflank (2 always-on services, no card) and the two hyperscaler serverless grants (Cloud Run, Azure Container Apps; both need a card/billing account) still offer free container compute. Fly.io, Railway (beyond a 30-day/$5 trial), Koyeb (new sign-ups), Sevalla (apps) and Cloudflare Containers have no real free container tier. Vercel Hobby is free for Next.js but is limited to personal, non-commercial use.

### Cited Findings

**Render**
- Free web service spins down after 15 minutes with no inbound HTTP/WebSocket traffic. Spin-up takes about one minute, and the browser shows a loading page meanwhile. — [Render docs: Deploy for Free](https://render.com/docs/free)
- 750 free instance hours per workspace per calendar month. Spun-down services use no hours. When hours run out, free services are suspended until next month, and unused hours don't roll over. — [Render docs: Deploy for Free](https://render.com/docs/free)
- Free services count against the workspace's included outbound bandwidth and pipeline (build) minutes. Without a payment method, going over suspends free services for the rest of the month (bandwidth) or disables new builds (build minutes). The free-docs page doesn't say a card is required to start. — [Render docs: Deploy for Free](https://render.com/docs/free)
- Custom domains and managed TLS are supported on free. Render warns against using free instances for production. — [Render docs: Deploy for Free](https://render.com/docs/free)
- Background workers are not free. A Render staff member said only "web/postgres/redis" are allowed for free, and Render admitted the pricing page needed fixing on this point. The cheapest worker is Starter, about $7/month (512 MB, 0.5 vCPU) per third-party trackers. One snapshot of the pricing page shows $10, so check before quoting. — [Render community](https://community.render.com/t/web-worker-not-part-of-the-free-plan/24555); [Activepieces Render pricing 2026](https://www.activepieces.com/blog/render-pricing-2026-free-tier-workers-total-cost)
- The free instance is described as 512 MB RAM / 0.1 CPU in a Render community thread title. — [Render community](https://community.render.com/t/the-free-instance-type-e-g-512mb-ram-0-1-cpu/39044)
- Bundled data services: free Postgres (1 per workspace, 1 GB, no backups) expires 30 days after creation, with a 14-day grace period before deletion. Free Key Value (Redis-compatible) is one per workspace and in-memory only, so data is lost on restart. — [Render docs: Deploy for Free](https://render.com/docs/free)

**Northflank**
- The free "Sandbox" tier has 2 services, 2 jobs and 1 database add-on, with up to $20/month of resources on Northflank Cloud ("Limited" compute, no per-service RAM/CPU cap shown). It is "Always on, no sleeping" and "No card needed". It also includes 1 BYOC cluster. — [Northflank pricing](https://northflank.com/pricing)
- At the time of fetch, the pricing page said Northflank had a security incident and advised users to rotate user-defined credentials. — [Northflank pricing](https://northflank.com/pricing)
- Singapore is a Northflank managed region (added January 2024). No source confirms that the free Sandbox can deploy there. — [Northflank changelog](https://northflank.com/changelog/introducing-new-regions-amsterdam-and-singapore); [Northflank regions](https://northflank.com/cloud/northflank/regions)
- Third-party sources disagree on whether a card is needed for activation; the official pricing page says no card. — summarized from search results incl. [freetier.co](https://freetier.co/directory/products/northflank)

**Koyeb**
- Koyeb agreed to join Mistral AI (announced Feb 17, 2026). The blog says the Starter plan "will soon be removed": new users need a Pro, Scale or Enterprise subscription, and sign-up requires a valid payment method and a paid plan. Existing Starter organizations are unchanged. — [Koyeb blog](https://koyeb.com/blog/koyeb-is-joining-mistral-ai-to-build-the-future-of-ai-infrastructure)
- The current pricing page lists only Pro ($29/mo), Scale ($299/mo) and Enterprise, plus a "Free 5h" Postgres option (0.25 vCPU, 1 GB RAM, 1 GB storage; regions Washington, Frankfurt, Singapore). — [Koyeb pricing](https://koyeb.com/pricing)
- The legacy free instance (docs still online) is 512 MB RAM, 0.1 vCPU and 2 GB SSD, in Frankfurt or Washington only (no Singapore). It scales to zero after 1 hour without traffic and is limited to one per organization. It runs a Web Service only, not a Worker. — [Koyeb docs: instances](https://www.koyeb.com/docs/reference/instances)
- Conflict: a July 2026 third-party review still describes a free "Hobby" plan. It contradicts Koyeb's own blog and pricing page and should be treated as outdated. — [Gappsy](https://gappsy.com/tools/koyeb/)

**Fly.io**
- "No free tier. New organizations don't have a free tier or a monthly free usage allowance." The trial is $1 of credit for 7 days with no card to start. After that, a credit card is required. Orgs on plans discontinued in October 2024 keep their legacy allowances. — [Fly.io pricing](https://docs.fly.io/about/pricing)
- Singapore shared-cpu-1x with 1 GB RAM costs about $8.50/month. — [Fly.io pricing](https://docs.fly.io/about/pricing)

**Railway**
- The trial lasts up to 30 days with a one-time $5 credit; trial users get 1 GB RAM, shared vCPU and 5 services per project. Without GitHub verification, the "Limited Trial" restricts outbound network access. After the trial, the Free plan gives "$1 of free credit per month" (no rollover). — [Railway docs: free trial](https://docs.railway.com/reference/pricing/free-trial)

**Vercel (Next.js only)**
- Hobby includes 4 CPU-hours of Active CPU, 360 GB-hours of provisioned memory, 1M function invocations, 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer and 1M CDN requests per month. Function max duration is 300 s and runtime logs are kept 1 hour. If you exceed a limit, you usually wait 30 days before using the feature again. — [Vercel Hobby docs](https://vercel.com/docs/plans/hobby) (last updated 2026-09-14)
- "the Hobby plan restricts users to non-commercial, personal use only." — [Vercel Hobby docs](https://vercel.com/docs/plans/hobby)
- Vercel now has "Daemons" for background workers (BullMQ etc.) declared in vercel.json. The Hobby page doesn't list Daemons as an included Hobby resource. — [Vercel Hobby docs related links](https://vercel.com/docs/plans/hobby)

**Google Cloud Run**
- Free tier (request-based billing): 2M requests, 180,000 vCPU-seconds and 360,000 GiB-seconds per month, plus 1 GB outbound from North America. A billing account is required, and Free Trial sign-up needs a card ($300 credit for 90 days). — [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features)
- The Compute Engine e2-micro free VM is only in us-west1, us-central1 and us-east1, not Singapore. — [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features)

**Azure Container Apps**
- Consumption plan: "The first 180,000 vCPU-seconds, 360,000 GiB-seconds, and 2 million requests per subscription per month are free." Idle replicas are billed at a reduced rate. Southeast Asia (Singapore) is a supported region; the page shows no region exception to the grant. — [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)

**Zeabur**
- Free Plan services auto-sleep after inactivity and wake on the next request, with a few seconds of cold start. There is no SLA. The monthly free credit is "Limited (varies by account status)", and when it runs out, services are suspended until reset. The Dev plan is US$5/month. — [Zeabur docs: free plan](https://zeabur.com/docs/en-US/pricing/free-plan); [Zeabur free quota](https://zeabur.com/docs/subscription/free-quota)
- A third party claims a $5/month credit with up to 1 vCPU and 2 GB. This is unverified and conflicts with the official wording. — [Toolradar](https://toolradar.com/tools/zeabur/pricing)

**Sevalla (formerly Kinsta) and Cloudflare**
- Sevalla's free tier covers static sites only. Application hosting starts at $5/month (0.3 CPU / 0.3 GB), and new accounts get $50 of credit. — [Sevalla pricing](https://sevalla.com/pricing); [agentdeals](https://agentdeals.dev/vendor/sevalla-formerly-kinsta)
- Cloudflare Containers need the Workers Paid plan ($5/month), which includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk. The free Workers plan doesn't include containers. — [DevClass](https://devclass.com/2025/07/01/cloudflare-container-platform-in-public-preview-with-scale-to-zero-pricing-some-initial-limitations/); [Cloudflare blog](https://blog.cloudflare.com/ko-kr/containers-are-available-in-public-beta-for-simple-global-and-programmable)

### Inferences
- 180,000 vCPU-seconds is 50 vCPU-hours a month. That's enough for a scale-to-zero API or web container at 50–100 users, but an always-on container at 1 vCPU needs about 2.6M vCPU-seconds a month, far over the grant. So Cloud Run and Azure ACA are free only if the services scale to zero, which means cold starts. An always-on worker there would be billed, though a 0.25 vCPU / 0.5 GiB worker would be a few dollars a month (my estimate).
- Render's 750 hours covers one always-on free service (24 × 31 = 744 hours). Two always-awake services (web + API) would run out around day 15–16. Because idle services spin down, both can fit in practice, but each sleeps.
- Render has a Singapore region on paid plans (from general knowledge). The free-docs page doesn't confirm free instances there, so it's a gap.

### Gaps
- Exact Render Hobby bandwidth (often cited as 100 GB) and build-minute allowances (often cited as 500 min): the pricing page didn't render.
- Whether Render free instances, Northflank Sandbox and Cloud Run's free tier apply in Singapore (asia-southeast1).
- Northflank Sandbox per-service RAM/CPU and build limits.
- Netlify: not researched in detail. It's a Next.js host with a free plan, but it can't run a NestJS container or a BullMQ worker.
- Vercel Daemons pricing on Hobby: not confirmed.

## Can an always-on BullMQ worker run free anywhere, and what breaks with sleep and cold starts?

### Takeaway
Northflank Sandbox is the only no-card, no-sleep free option found that explicitly allows always-on services, and it gives 2 services. Render, Koyeb (legacy) and Zeabur free tiers either refuse workers or sleep them. Cloud Run and ACA can run a worker only as a billed always-on instance, or with min instances of 0, which won't consume BullMQ jobs.

### Cited Findings
- Render free tier doesn't allow background workers; they start at Starter (~$7/month). — [Render community](https://community.render.com/t/web-worker-not-part-of-the-free-plan/24555)
- The Koyeb free instance can't be a Worker Service, and it scales to zero after 1 hour. — [Koyeb docs](https://www.koyeb.com/docs/reference/instances)
- Northflank Sandbox: "Always on, no sleeping", 2 services and 2 jobs. — [Northflank pricing](https://northflank.com/pricing)
- Zeabur free services sleep on inactivity. — [Zeabur docs](https://zeabur.com/docs/en-US/pricing/free-plan)
- Render free cold start is about 1 minute after 15 min idle. — [Render docs](https://render.com/docs/free)
- Railway's free plan after the trial is $1/month of credit, too little for three Node services. — [Railway docs](https://docs.railway.com/reference/pricing/free-trial)

### Inferences
- A sleeping worker means BullMQ sync jobs queued by the API wait until something wakes the worker. On Render you can't even create a free worker. A common workaround is to run the worker inside the API process (or as a "web service" with a dummy HTTP port, pinged by an external cron). The ping trick would burn Render's 750 hours and may breach the spirit of the free tier.
- Northflank's 2 free services fit 2 of the 3 Krosa processes. Options:
  - (a) Run the web on Vercel Hobby (but see the non-commercial clause below) and put the API + worker on Northflank.
  - (b) Merge the worker into the API process on Northflank, then run the web as the second service.
  - (c) Use one of the 2 "jobs" as a cron sync. BullMQ needs a continuous consumer, so this means a code change.
- Students would see a Render cold start of about 60 s on the first visit after 15 minutes idle. Both web and API would be cold, so the first request could take longer. Cloud Run/ACA cold starts for Node are usually seconds, not a minute (general knowledge, not sourced here).

### Gaps
- No source confirms Northflank Sandbox resource size is enough for Next.js SSR + NestJS (Next.js builds often need 1–2 GB RAM).
- I couldn't confirm whether Northflank's free tier can be held for 6–12 months without changes. The page has no time limit, but there's also no stated guarantee.

## Which combination runs web + API + worker free for 6–12 months for 50–100 users, and is the use allowed (commercial/organisational)?

### Takeaway
Most workable fully-free mixes:
- (1) Northflank Sandbox for API + worker (always on), with the web on Render free (sleeps) or Vercel Hobby.
- (2) Everything on Northflank with the worker folded into the API.
- (3) Cloud Run or Azure ACA, with web and API scaling to zero within the free grant and a tiny always-on worker costing a few dollars (needs a card).

Vercel Hobby's "non-commercial, personal use only" clause makes it a poor fit for an organisation like PNC. Render, Koyeb and Railway don't give a sustained free worker.

### Cited Findings
- Vercel Hobby: non-commercial, personal use only. — [Vercel Hobby docs](https://vercel.com/docs/plans/hobby)
- Render warns free instances aren't for production. The free Postgres expires after 30 days, and the free Key Value loses data on restart (bad for BullMQ queues). — [Render docs](https://render.com/docs/free)
- Fly.io: no free tier for new orgs. — [Fly.io pricing](https://docs.fly.io/about/pricing)
- Koyeb: new sign-ups need a paid plan and a payment method. — [Koyeb blog](https://koyeb.com/blog/koyeb-is-joining-mistral-ai-to-build-the-future-of-ai-infrastructure)
- Cloud Run and Azure ACA grants are monthly and ongoing (not time-limited trials), but both need billing set up. ACA lists Southeast Asia. — [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features); [Azure ACA pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)
- Cheapest paid fallbacks found: Sevalla app $5/month, Cloudflare Workers Paid $5/month, Zeabur Dev $5/month, Render Starter worker ~$7/month, and Fly Singapore 1 GB about $8.50/month. — [Sevalla pricing](https://sevalla.com/pricing); [DevClass](https://devclass.com/2025/07/01/cloudflare-container-platform-in-public-preview-with-scale-to-zero-pricing-some-initial-limitations/); [Zeabur docs](https://zeabur.com/docs/en-US/pricing/free-plan); [Activepieces](https://www.activepieces.com/blog/render-pricing-2026-free-tier-workers-total-cost); [Fly.io pricing](https://docs.fly.io/about/pricing)

### Inferences
- What breaks:
  - (a) Render web/API sleep, so students get about 60 s first loads.
  - (b) Any sleeping worker leaves admin-triggered syncs stuck in the queue.
  - (c) Render free Key Value isn't durable, so BullMQ jobs are lost on restart.
  - (d) A Vercel web proxying to an API in another provider/region adds latency. Cambodia → Singapore is the best path, and US/EU-only free regions (Koyeb legacy, GCP e2-micro) add roughly 200–300 ms (general knowledge).
  - (e) Free tiers change often (Fly 2024, Koyeb 2026), so a 6–12-month plan should expect a mid-test migration.
- For a 6–12-month organisational test, a single small VM or one $5–7/month paid service may be more predictable than splitting across free PaaS tiers. That comparison belongs to the other researchers' VM findings.

### Gaps
- Northflank's and Render's terms of service weren't checked for clauses against commercial or organisational use. Only Vercel's restriction was confirmed.
- Netlify, Heroku (no free dynos since 2022, general knowledge), DigitalOcean App Platform (free static sites only, general knowledge) and Alibaba/Tencent Asia offers weren't verified in this pass.
