# Free virtual machines for the Krosa Docker Compose stack (as of November 2026)

Stack: Caddy, Next.js web (Node 22), NestJS API (Node 22), BullMQ worker (Node 22), PostgreSQL 17, Redis 7, nightly pg_dump container. Documented minimum: 2 vCPU / 4 GB RAM / 40 GB disk. Load: 50–100 users, low traffic, 6–12 months.

## Can the stack fit in less than 2 vCPU / 4 GB?

### Takeaway

Probably yes for runtime. 2 GB RAM should be comfortable at this load, and 1 GB with 2–4 GB swap is likely to run but is fragile. Building images on the server (especially `next build`) needs much more memory, so a small VM should pull images built elsewhere, for example in CI.

### Cited Findings

- No external source was used for this estimate. Everything below is an inference.

### Inferences

- Rough steady-state memory at low traffic, from typical figures (not measured on Krosa):
  - PostgreSQL 17: about 100–200 MB with modest `shared_buffers`.
  - Redis 7: about 10–50 MB for BullMQ queues.
  - Caddy: about 20–40 MB.
  - Next.js production server: about 150–300 MB.
  - NestJS API: about 100–200 MB.
  - Worker: about 100–200 MB. Spikes are likely while it reads a large workbook.
  - pg_dump container: idle except at night.
  - Total: about 0.6–1.0 GB.
- **1 GB (Oracle E2.1.Micro, GCP e2-micro):** will likely run with swap and `NODE_OPTIONS=--max-old-space-size` caps on each Node process. Expect swapping during syncs and slow responses. The Oracle micro also has only 1/8 OCPU plus burst, which is CPU-starved for three Node processes. It is not recommended beyond a demo.
- **2 GB (AWS t4g.small, Azure B2pts/B2ats v2 with 1 GB? see the Azure gap):** workable for 50–100 low-traffic users if images are prebuilt.
- **12 GB Arm (Oracle A1, 2 OCPU):** exceeds the documented minimum on RAM and meets it on CPU.
- Building on the box: a Next.js build commonly needs 2 GB or more. On 1–2 GB VMs, build the images on a dev machine or in CI (multi-arch if the target is Arm) and push them to a registry.

### Gaps

- No measured memory profile of Krosa exists. Run `docker stats` locally under a sync to confirm.

## Oracle Cloud Always Free

### Takeaway

This is still the best free fit, but the allowance changed in mid-2026. **Ampere A1 Always Free was halved to 2 OCPU / 12 GB**, from the widely quoted 4 OCPU / 24 GB. That is still enough for this stack, and it is indefinite (not time-limited). The main risks are:

- getting an account approved (card checks)
- "out of host capacity" in a busy home region such as Singapore
- idle reclamation (unlikely to trigger on A1 because of the RAM rule)
- Oracle changing the terms again without notice

### Cited Findings

- **Current official limits:** A1.Flex is 1,500 OCPU-hours and 9,000 GB-hours per month, which the doc equates to 2 OCPUs and 12 GB memory. It can be one instance or two 1-OCPU instances. E2.1.Micro (AMD) allows up to 2 instances, each with 1/8 OCPU (burstable), 1 GB RAM and up to 50 Mbps to the internet. — [Oracle docs: Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- **Storage:** 200 GB combined boot and block volume, home region only. Boot volume minimum is about 47–50 GB (the doc is inconsistent). 5 volume backups. 20 GB Object Storage. — [Oracle docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- **Egress:** 10 TB per month outbound. Outbound port 25 is blocked by default. — [Oracle docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- **Home region:** Always Free compute must be in the tenancy's home region. "Out of host capacity" means free shapes are temporarily unavailable there; try another availability domain or retry later. — [Oracle docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- **Idle reclamation:** Oracle may reclaim Always Free instances idle over 7 days. That means 95th-percentile CPU under 20%, network under 20%, and memory under 20% (the memory test applies to A1 only). — [Oracle docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- **The halving:**
  - It took effect June 15, 2026, with no blog post or customer notice; only the docs changed. Free-only accounts above the limit had instances shut down until they were resized.
  - Oracle support emails reportedly said pay-as-you-go accounts keep 4 OCPU / 24 GB free, but this is not published, and the docs still say "All tenancies".
  - Source: [InfoQ, July 2026](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/).
  - Another report gives August 18, 2026 as the date. — [zeli.app](https://zeli.app/en/story/49183750); also [linuxiac](https://linuxiac.com/oracle-quietly-cuts-free-tier-ampere-a1-resources-in-half/)
- **Sign-up and cards:**
  - Common sign-up errors come from prepaid cards. — [Oracle forums](https://forums.oracle.com/ords/apexds/post/signup-issues-with-oracle-cloud-free-tier-account-7894)
  - Virtual and prepaid cards are almost always rejected, some debit cards fail, major-bank credit cards succeed most often, and VPN use raises the rejection rate. — [ITNext](https://itnext.io/why-creating-an-oci-free-tier-account-is-so-hard-and-what-you-can-do-instead-7a06b83ec576)
  - Trustpilot reviews report repeated rejections. — [Trustpilot](https://ca.trustpilot.com/review/cloud.oracle.com)
- **Singapore capacity:** an anecdote of a Singapore-home-region free account that could never create an instance (out of capacity). — [LowEndTalk](https://lowendtalk.com/discussion/comment/3711352/)
- **Asia regions:**
  - Oracle has one Singapore region, and a second Singapore region was announced in 2023. — [ComputerWeekly](https://www.computerweekly.com/news/365534834/Oracle-to-open-second-cloud-region-in-Singapore)
  - A Batam (Indonesia) facility is still reported as planned, with no go-live found. — [The Star, July 2025](https://www.thestar.com.my/business/business-news/2025/07/14/oracle-said-to-advance-indonesia-cloud-services-plan)

### Inferences

- **Fit:** 2 OCPU / 12 GB Arm with a 200 GB disk fits the stack well. Use one A1 instance (2 OCPU / 12 GB) with a 100–150 GB boot volume.
- **Arm64:** the official Docker images for `node:22`, `postgres:17`, `redis:7` and `caddy:2` are published as multi-arch, including arm64. This is from general knowledge and was not re-checked in this session. Krosa's own images must be built for `linux/arm64`, for example with `docker buildx --platform linux/arm64` or by building on the VM, which has enough RAM. Check any native npm dependencies (for example `bcrypt`, `sharp`, Prisma engines) for arm64. Prisma supports `linux-arm64-openssl-3.0.x`.
- **Reclamation:** the A1 rule requires CPU, network _and_ memory all under 20%. Postgres, Node and Redis on a 12 GB box will likely use under 20% of RAM (2.4 GB), so a quiet test instance _could_ meet all three. Possible mitigations:
  - Raise `shared_buffers` or other caches so memory sits above 20%.
  - Upgrade the account to pay-as-you-go. This is reported to exempt it from reclamation and possibly from the halving. Those two claims are not confirmed in the official docs fetched here.
  - Set a budget alert at $1.
- **Capacity:** pick the home region carefully at sign-up, because it cannot be changed later. Singapore is closest to Phnom Penh. If capacity fails there, nearby alternatives include Tokyo, Osaka, Seoul, Chuncheon, Mumbai, Hyderabad, Sydney and Melbourne, but none was verified for capacity. Another option is to keep retrying instance creation with a script.
- **Duration:** Always Free is not time-limited, so it covers 6–12 months if the account survives. The June 2026 change shows Oracle can cut limits without notice.

### Gaps

- **Cambodia sign-up:** no source confirms whether Cambodia is a supported country for OCI sign-up, or reports success or failure for Cambodian cards. Oracle's FAQ page (oracle.com/sg/cloud/free/faq) returned 403. oracle.com/cloud/free also returned 403, so the marketing page's current numbers and the 30-day $300 trial credit were not verified.
- **PAYG status:** whether PAYG accounts keep 4 OCPU / 24 GB is unresolved (only support emails, per InfoQ).
- **Current Singapore capacity:** no current (late-2026) data on A1 capacity in Singapore.

## AWS Free Tier (post-July 2025)

### Takeaway

New accounts get a credit-based Free plan: up to $200 for 6 months. The account then **closes automatically** unless it is upgraded to paid. On the Free plan alone, it cannot cover 12 months. A t4g.small (2 vCPU / 2 GB Arm) can likely run for the full 6 months within credits. To reach 12 months, upgrade to the Paid plan: the remaining credits carry over, and a separate t4g.small trial is free (750 h/month) until Dec 31, 2026. The old 12-month t2/t3.micro free tier only applies to accounts created before July 15, 2025.

### Cited Findings

- **Credits:** $100 at sign-up plus up to $100 earned through activities. The Free plan ends after 6 months or when credits run out, whichever is first. The account then closes, data is kept 90 days, and you can upgrade within 90 days; unused credits carry to the paid account. — [AWS Billing docs: Choosing a plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)
- **Free plan restrictions:** select services only. The account auto-upgrades to paid if it joins AWS Organizations, among other triggers. The Paid plan gets the same credits and is charged beyond them. — [AWS Billing docs](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html); [aws.amazon.com/free](https://aws.amazon.com/free/)
- **Eligible instances:**
  - Accounts created on or after July 15, 2025: t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large and m7i-flex.large are "free tier eligible". Usage draws on the credits, and "You can't exceed your Free Tier limits".
  - Accounts created before July 15, 2025: t2.micro and t3.micro, 12 months, billed beyond limits.
  - Source: [AWS EC2 docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html)
- **t4g.small trial:** free for up to 750 hours per month until Dec 31, 2026 for all customers, shared across an AWS Organization. — [AWS T4g page](https://aws.amazon.com/ec2/instance-types/t4/); [Classmethod](https://dev.classmethod.jp/en/articles/ec2-t4g-small-free-tier-2026/)

### Inferences

- **Costs against credits (approximate, from memory, not verified this session):**
  - t4g.small in Singapore: about $0.02/h, so about $15/month.
  - Public IPv4: $0.005/h, about $3.6/month.
  - 30–40 GB gp3: about $3–4/month.
  - Total: about $20–25/month, so $200 lasts about 8–10 months. In practice the Free plan cuts off at 6 months.
- **m7i-flex.large** (2 vCPU / 8 GB) meets the documented minimum but costs roughly $0.1/h or more, about $70+/month. $200 would last about 3 months.
- **Workable path to 12 months:** sign up, upgrade to the Paid plan, and run t4g.small on the free trial through Dec 31, 2026, while credits absorb IPv4, EBS and after-trial compute. This needs a card and carries billing risk, so set budgets and alerts.
- **Asia region:** ap-southeast-1 (Singapore) is available.
- **Card:** a credit or debit card is required for AWS sign-up (general knowledge; the free page did not state it).

### Gaps

- Exact Singapore prices for t4g.small, IPv4 and EBS were not fetched.
- Whether the t4g.small trial extends past Dec 31, 2026 is unknown.
- Whether the t4g.small trial applies on the Free plan or only on the Paid plan is not clear from the sources.

## Google Cloud

### Takeaway

The free e2-micro is US-only (Oregon, Iowa, South Carolina) with 1 GB RAM, a 30 GB standard disk and only 1 GB/month of egress. It is far from Cambodia and too small for this stack except as a demo. The $300 trial lasts only 90 days, so it does not cover 6–12 months.

### Cited Findings

- **$300 trial:** valid for 90 days. Afterwards the trial closes and resources stop unless you upgrade. — [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features)
- **Free Tier:**
  - One non-preemptible e2-micro per month in us-west1, us-central1 or us-east1.
  - 30 GB-months of standard persistent disk.
  - 1 GB/month egress from North America (excluding China and Australia).
  - Google can change it with 30 days' notice.
  - Source: [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features)
- **Card:** a credit card or other payment method is required, with a temporary $0–1 authorization hold. Some countries also need bank verification. — [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features)

### Inferences

- **Fit:** 1 GB RAM (e2-micro has 2 shared vCPUs at a 0.25 fraction, from general knowledge) plus a 30 GB disk, below the 40 GB documented need, means a poor fit. Latency from Phnom Penh to the US is about 200+ ms. The 1 GB egress cap could be exceeded by a Next.js app serving pages to 100 users; overage is billed.
- **External IPv4:** whether the external IPv4 on e2-micro is billed was not verified.

### Gaps

- The external IP charge for the free e2-micro was not confirmed.

## Microsoft Azure

### Takeaway

The free account gives 12 months of 750 h/month each of B1s, B2pts v2 (Arm) and B2ats v2 (AMD) burstable VMs, plus $200 credit for 30 days. A card is required, and you must move to pay-as-you-go within 30 days to keep the 12-month services. This could cover 12 months on a small VM. Azure for Students ($100, 12 months, no card) only applies to full-time university students, which does not suit an organisation account.

### Cited Findings

- **Free VMs:**
  - 750 hours each of B1s, B2pts v2 and B2ats v2, free for 12 months, as a monthly limit. One Microsoft Q&A answer reads it as a total rather than per month. — [Azure free VMs page](https://azure.microsoft.com/en-us/free/virtual-machines/); [Microsoft Learn: free services](https://learn.microsoft.com/mt-mt/azure/cost-management-billing/manage/create-free-services)
  - Some users report no quota for B2pts v2 / B2ats v2 on Free or Student subscriptions. — [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/1440468/no-b2ats-v2-and-b2pts-v2-quota-for-azure-student)
- **Keeping the 12-month services:** new customers must move to pay-as-you-go within 30 days. — [Azure free services](https://azure.microsoft.com/en-us/pricing/free-services)
- **Azure for Students:**
  - $100 credit valid 12 months, no credit card, full-time university students with a school email, renewable yearly.
  - Includes 750 h of B-series VMs and Azure Database for PostgreSQL, free 12 months.
  - Source: [Azure for Students](https://azure.microsoft.com/en-us/free/students)

### Inferences

- **VM sizes (from general knowledge; not confirmed on the fetched pages):**
  - B1s: 1 vCPU / 1 GB.
  - B2pts v2: 2 vCPU / 1 GB, Arm.
  - B2ats v2: 2 vCPU / 1 GB, AMD.
  - All three are 1 GB RAM, which means the 1 GB-with-swap scenario.
  - The free account also includes 2 × 64 GB P6 SSD managed disks for 12 months (general knowledge, unverified).
  - Southeast Asia (Singapore) is an Azure region. Free VMs are usually available there, but not verified.
- **Bandwidth:** egress is about 100 GB/month free (general knowledge, unverified).

### Gaps

- Exact RAM of B2pts v2 / B2ats v2 and the free disk and egress amounts were not confirmed from official pages in this session. The free-services page did not list them.
- No source on Azure sign-up from Cambodia.

## Others and the lowest paid fallback

### Takeaway

- **Alibaba Cloud:** offers free ECS trials of up to 12 months, but the sources conflict on terms (often 1 vCPU) and none ties them to Singapore.
- **Hetzner:** raised prices twice in 2026, and its cheapest plans were reported as not orderable in October 2026.
- **Mainstream 2 vCPU / 4 GB VPS in Singapore** (DigitalOcean, Vultr): about $20–28 per month.

### Cited Findings

- **Alibaba Cloud:**
  - ECS trial packages are valid for up to 12 months.
  - They are subscription-type, so they do not auto-bill after expiry.
  - Eligibility requires no prior trial order.
  - Changing specs can end the $0 price.
  - Sources: [Alibaba Cloud blog](https://www.alibabacloud.com/blog/an-introduction-to-alibaba-cloud-free-trial_599913); [cloudtoolstack guide](https://cloudtoolstack.com/learn/alibaba-getting-started-guide)
  - Instance size is reportedly 1 vCPU; the sources conflict. — [8gwifi](https://8gwifi.org/docs/alibabacloud.jsp)
- **Hetzner:**
  - Price increases took effect April 1 and June 15, 2026.
  - Cost-optimized plans (CX23, CAX11) were reported with a disabled Create button through October 20, 2026.
  - EU prices conflict: CX23 €3.99–5.49, CAX11 €4.49–5.99.
  - Sources: [bitdoze](https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans); [webhosting.today](https://webhosting.today/2026/06/18/hetzners-price-increases-reached-209-the-30-headline-applied-to-a-different-tier/); [Tom's Hardware](https://www.tomshardware.com/tech-industry/hetzner-to-raise-prices-by-up-to-37-percent-from-april-1)
  - Singapore is 40–67% more expensive than the EU. — [costgoat](https://costgoat.com/pricing/hetzner)
- **DigitalOcean / Vultr, 2 vCPU / 4 GB:**
  - Typically $24/month; one aggregator lists a DigitalOcean Premium Intel 2 vCPU / 4 GB at $28/month in Singapore.
  - These are third-party figures, not official pricing pages.
  - Sources: [Cloud Mercato](https://pcr.cloud-mercato.com/providers/digitalocean/flavors/s-2vcpu-4gb-intel); [Better Stack](https://betterstack.com/community/guides/web-servers/digitalocean-vs-vultr/)

### Inferences

- **Cheapest realistic paid fallback in Asia:**
  - About $24/month for 2 vCPU / 4 GB at DigitalOcean or Vultr in Singapore.
  - About $12/month for 2 GB, which likely suffices.
  - Over 12 months, that is about $144–288.
  - Hetzner Singapore might be cheaper but availability is uncertain.
  - The DigitalOcean and Vultr sub-$20 and 2 GB prices are from general knowledge.
- **Cost-reduction options:** nonprofit and education programmes may lower the cost; these were not researched here.
  - TechSoup Azure grants, about $2,000/year for eligible nonprofits.
  - AWS Imagine Grant / nonprofit credits.
  - GitHub Student Developer Pack (DigitalOcean credit) for staff or student developers.

### Gaps

- Official Singapore list prices for DigitalOcean, Vultr and Hetzner were not fetched.
- Alibaba's current free-trial page was not fetched, so terms are unconfirmed.
- Nonprofit credit programmes (Microsoft for Nonprofits / TechSoup, AWS nonprofit credits, Google for Nonprofits) and their availability in Cambodia were not researched.
