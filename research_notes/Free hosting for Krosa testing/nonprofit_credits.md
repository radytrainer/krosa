# Cloud credits and free hosting for a Cambodian nonprofit school (as of Nov 2026)

Context: PNC (Passerelles Numériques Cambodia) needs one Linux/Docker server (2 vCPU / 4 GB RAM, 50–100 users) for 6–12 months at no cost. Research date: 2026-11-05. Many programme pages are undated; flagged where so.

## AWS: Nonprofit Credit Program (TechSoup), Imagine Grant, Free Tier, Educate/Academy/Activate

### Takeaway

The AWS Nonprofit Credit Program (up to $5,000, 1 year, via TechSoup or a TechSoup partner) is "offered globally", but AWS **excludes educational institutions, including trade schools**, so PNC would qualify only if it applies as the registered NGO rather than as a school. The Imagine Grant is limited to six English-speaking countries (Cambodia not included). The quickest no-paperwork option is the AWS Free Tier free plan ($100–$200 of credit, ends after 6 months).

### Cited Findings

- AWS Nonprofit Credit Program: up to **$5,000 USD** in AWS Promotional Credit; valid at least one year from receipt or until used; one grant per fiscal year (Jul 1–Jun 30); after it runs out or expires, normal billing applies — [AWS Nonprofit Credit Program](https://aws.amazon.com/government-education/nonprofits/nonprofit-credit-program/)
- Same page: "offered globally"; US organisations request through TechSoup; international organisations find a partner NGO through TechSoup's global site, which also checks eligibility. You get a promo code by email and redeem it in the Billing Dashboard — [AWS Nonprofit Credit Program](https://aws.amazon.com/government-education/nonprofits/nonprofit-credit-program/)
- **Exclusion:** "Educational institutions, including K-12 schools, colleges, universities, and trade schools, are not eligible"; they are pointed to AWS Educate instead. Credits only cover on-demand services: no Reserved Instances, Marketplace or Route 53 domain registration — [AWS Nonprofit Credit Program](https://aws.amazon.com/government-education/nonprofits/nonprofit-credit-program/)
- Older 2017 AWS blog: the TechSoup grant was then $2,000, usable for 12 months, rolled out "by region". **Outdated**; the current page says up to $5,000 — [AWS Public Sector Blog, Aug 2017](https://aws.amazon.com/blogs/publicsector/global-expansion-of-the-aws-nonprofit-credit-program-with-techsoup)
- AWS Imagine Grant 2026 is open only to nonprofits in the US, UK, Ireland, Canada, Australia and New Zealand; the Round One deadline was 5 June 2026 (closed) — [AWS Imagine Grant](https://aws.amazon.com/government-education/nonprofits/aws-imagine-grant-program); [fundsforNGOs](https://www2.fundsforngos.org/?p=452897)
- AWS Free Tier (since 15 July 2025): new customers get $100 in credit at sign-up and can earn up to $100 more by trying services. The "free account plan" ends 6 months after sign-up or when credits run out, whichever comes first. Alerts are sent at 50/25/10% remaining and 15/7/2 days before the end — [AWS What's New, Jul 2025](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/); [AWS News Blog](https://aws.amazon.com/blogs/aws/aws-free-tier-update-new-customers-can-get-started-and-explore-aws-with-up-to-200-in-credits)
- Sources disagree on whether Free Tier credits last 12 months once you move to a paid plan — [Techzine](https://www.techzine.eu/news/applications/133095/aws-renews-free-tier-with-credit-up-to-200/); [RedMonk](https://redmonk.com/videos/the-new-builders-the-new-aws-free-tier/)

### Inferences

- PNC is legally an NGO (part of the French NGO Passerelles Numériques) that runs a vocational school. AWS's explicit "trade schools" exclusion is the main risk. An application presented as the NGO, with NGO registration papers, may pass TechSoup checks, but there is a real chance of rejection. This is not confirmed either way.
- Rough cost: a 2 vCPU / 4 GB instance (e.g. t3.medium/t4g.medium) runs on the order of $25–35/month on-demand. The $200 Free Tier would cover roughly 6 months, which matches the plan's 6-month cap. A $5,000 nonprofit credit would more than cover 12 months. These prices are not from a cited source in this research; verify with the AWS pricing calculator.
- The Free Tier needs a payment card at sign-up (widely known, but not confirmed in the sources fetched).

### Gaps

- AWS Educate / AWS Academy (for institutions) and AWS Activate: not researched within the tool budget. AWS Educate historically gives student lab accounts without production hosting rights, and Activate targets startups, so neither suits PNC. This is unverified for 2026.
- Whether TechSoup or a partner validates Cambodian organisations for the AWS offer (see the TechSoup section).
- Approval time for the AWS nonprofit credit: no source found.

## Microsoft: Azure nonprofit grant and Azure for Students

### Takeaway

Microsoft for Nonprofits lists Azure among its offers (third-party and community sources say $2,000/year, renewed yearly). Its eligibility page **excludes "schools, colleges and universities including formal educational institutions"**, and Cambodia's eligibility isn't stated on the page fetched. Azure for Students ($100, 12 months, no card) is for full-time university students, so it's personal, small and fragile for an organisation's test server.

### Cited Findings

- Eligible: nonprofits/NGOs with recognised charitable status in their country. Excluded: "Schools, colleges and universities including formal educational institutions" (pointed to academic licensing), plus government, most hospitals and others — [Microsoft Nonprofits eligibility](https://www.microsoft.com/en-us/nonprofits/eligibility)
- The eligibility page names no countries; Microsoft says offers vary by country and availability is confirmed through the nonprofit portal verification. Microsoft's FAQ claims programmes in "over 200 countries" — [Microsoft Nonprofits eligibility](https://www.microsoft.com/en-us/nonprofits/eligibility); [Microsoft Nonprofits FAQ](https://www.microsoft.com/zh-CN/nonprofits/faq)
- Azure grant amount: several 2025–2026 sources say **$2,000/year** in Azure credit. Unused credit doesn't roll over and the grant must be renewed each year (renewal opens up to 30 days before) — [4sight](https://4sight.cloud/blog/azure-grant-update-and-dynamics-365-grant-sunset); [Microsoft FAQ (en-ca)](https://www.microsoft.com/en-ca/nonprofits/faq); [Granted AI](https://grantedai.com/grants/azure-sponsorship-for-nonprofits-microsoft-d57a3587). One Microsoft Q&A answer cites $3,500 / up to $20,000; this conflicts with the others and is treated as unreliable — [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5917171/how-can-i-apply-for-azure-grants-for-nonprofit)
- Users in 2026 report renewed grants not attaching to subscriptions, with pay-as-you-go billing continuing — [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5779134/nonprofit-azure-grant-renewed-but-not-applied-to-e); [Microsoft Q&A](https://learn.microsoft.com/en-ca/answers/questions/5772432/help-with-billing)
- Azure for Students: $100 credit for 12 months, renewable yearly while still a student; **no credit card**; "full-time university students" only, sign-up with a school email, one account per person; 750 hours/month of B-series VM for 12 months; the subscription is disabled when credit runs out unless upgraded — [Azure for Students](https://azure.microsoft.com/en-us/free/students)

### Inferences

- The Azure nonprofit grant ($2,000/yr) would cover a 2 vCPU / 4 GB VM for 12 months if PNC passes verification as an NGO; the school exclusion is the same risk as with AWS.
- Azure for Students needs a "university" email that Azure recognises. A PNC student's or staff member's eligibility is uncertain, the account belongs to an individual, and $100 is too small for a B2s-class VM for 12 months. Fine for a short demo only.
- Using a student's personal credits for organisational hosting may conflict with the programme's intent or terms. This is not verified.

### Gaps

- Whether Cambodia is an available market for Microsoft for Nonprofits: no official list found.
- Approval time: no authoritative source.

## Google for Nonprofits / Google Cloud

### Takeaway

Google for Nonprofits **lists Cambodia** as an eligible country, but it excludes schools and academic institutions ("philanthropic arms of educational organizations are eligible"). Google Cloud credits for nonprofits are reported at up to $2,000/year, though only by an aggregator.

### Cited Findings

- Cambodia is on the Google for Nonprofits country list. Registration types shown include local NGOs registered with the Ministry of Interior and foreign NGOs registered with the Ministry of Foreign Affairs — [Google for Nonprofits eligibility](https://support.google.com/nonprofits/answer/3215869?hl=en)
- Ineligible: governmental entities; hospitals; "Schools, academic institutions, or universities" (philanthropic arms are eligible) — [Google for Nonprofits eligibility](https://support.google.com/nonprofits/answer/3215869?hl=en)
- Google Cloud credits for nonprofits: "up to $2,000 USD per year" per an aggregator; not confirmed on an official Google page — [Granted AI](https://grantedai.com/grants/google-for-nonprofits-cloud-ai-credits-google-org-google-cloud-b824e26f)

### Inferences

- As a foreign-NGO branch registered with Cambodia's MFA, PNC may fit Google's registration categories. Its education mission is the eligibility risk, as with Microsoft and AWS.

### Gaps

- Official Google Cloud nonprofit credit amount, duration and approval time (the help article contents were not retrieved).
- Google Cloud standard $300/90-day free trial and education credits: not verified in this research.

## GitHub Student Developer Pack

### Takeaway

As of Nov 2026, the Pack page **no longer lists DigitalOcean**. Hosting value is Heroku ($13/month for 24 months) and Azure ($100). These are personal student benefits, small, and need verified student status, so they're realistic only for a short demo run by a PNC student.

### Cited Findings

- Current hosting offers: Heroku $13/month credit for 24 months; Azure $100 credit plus 25+ free services (18+); a reduced Azure set for ages 13–17; Appwrite Education plan for 6 months; GitHub Codespaces Pro; Namecheap .me domain and .TECH domain for 1 year. **DigitalOcean, Render and Railway are not on the page** — [GitHub Student Developer Pack](https://education.github.com/pack)
- The page links teacher programmes but describes no teacher hosting credits — [GitHub Student Developer Pack](https://education.github.com/pack)

### Inferences

- The well-known "$200 DigitalOcean" Pack offer appears to be gone; treat older blog posts claiming it as outdated.
- Heroku's $13/month fits only a basic or eco dyno plus a small database, not a Docker VM of 2 vCPU / 4 GB. Krosa (api + worker + web + Postgres + Redis) would need re-architecting for Heroku.

### Gaps

- Exact student verification rules for a Cambodian vocational institution (whether PNC is recognised by GitHub Education) were not confirmed.

## DigitalOcean, Oracle, Cloudflare Galileo, TechSoup Cambodia

### Takeaway

DigitalOcean for Nonprofits (successor to Hub for Good) offers **$2,500 one-time credits, expiring after 1 year**, to "global equivalents" of 501(c)(3)s and even unregistered social-impact projects. It shows no school exclusion in the sources found, which makes it the best-fitting credit programme. Oracle Always Free is now **2 OCPU / 12 GB Arm** (cut from 4/24), which is still enough for this workload with no time limit. Cloudflare Galileo is security-only, not hosting. No TechSoup partner for Cambodia was found.

### Cited Findings

- Hollie's Hub for Good was relaunched in 2023 as "DO for Nonprofits and Social Enterprises": $2,500 one-time credit; eligible are US 501(c)(3)s "or global equivalents", social enterprises and unregistered social-impact initiatives; credits expire 1 year from application; eligibility is checked via Percent, then a DO application; past Hollie's recipients are ineligible — [DigitalOcean blog](https://www.digitalocean.com/blog/driving-impact-do-for-nonprofits-social-enterprises); [DigitalOcean nonprofits](https://DigitalOcean.com/impact/nonprofits). Pages are undated, so confirm 2026 terms.
- Sources conflict on a Cloudways alternative ($100 + discount vs 20% discount) — [plushcap summary](https://plushcap.com/content/digitalocean/blog/digitalocean-driving-impact-do-for-nonprofits-social-enterprises)
- Oracle Always Free (official doc, 2026): A1 Arm gets 1,500 OCPU-hours and 9,000 GB-hours/month = **2 OCPUs and 12 GB RAM**; 200 GB block storage; instances only in the home region; "out of host capacity" errors possible; idle instances reclaimed if 95th-percentile CPU, network and (A1) memory stay below 20% over 7 days — [Oracle Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)
- Third-party 2026 posts report the reduction from 4 OCPU / 24 GB to 2 / 12; older guides citing 4/24 are **outdated** — [Hacker News mirror "Oracle is reducing their free tier quota"](https://hackernews-dynamic.seasondane.workers.dev/news/48525809); [space-node guide 2026](https://space-node.net/blog/oracle-cloud-free-vps-guide-2026)
- Cloudflare Project Galileo gives Business-plan security (DDoS/WAF) free to at-risk civil-society, journalism and human-rights sites, often via partner-organisation referral; it is not compute hosting — [Cloudflare Galileo](https://www.cloudflare.com/sv-se/galileo/); [Granted AI](https://grantedai.com/grants/project-galileo-cloudflare-0b2c9996)
- TechSoup: donor partners set eligibility by country and offer; organisations must register and be validated — [TechSoup support](https://support.techsoup.org/hc/en-001/articles/37928263254555-What-offers-are-my-organization-eligible-for). TechSoup Asia-Pacific is said to serve 43 APAC countries, but no Cambodia-specific partner was found — [Open Development Mekong](https://data.laos.opendevelopmentmekong.net/organization/about/techsoup-asia-pacific)

### Inferences

- **Most realistic and fastest overall:**
  1. **Oracle Always Free.** Free indefinitely, no application. 2 OCPU / 12 GB Arm exceeds the 2 vCPU / 4 GB need, so it fits Docker if images are built for arm64. Caveats: card verification at sign-up (commonly reported, not confirmed here), capacity errors in popular regions, and idle reclaim (a 50–100 user test server may sit below 20% and get reclaimed). Converting to Pay-As-You-Go while staying within Always Free limits is a commonly cited workaround, not verified here.
  2. **DigitalOcean for Nonprofits** ($2,500 / 1 year). Covers a $24/month 2 vCPU / 4 GB droplet many times over, has an explicit global scope, and shows no school exclusion. Approval time is unknown.
  3. **AWS Free Tier** ($100–200, 6 months). Immediate, but the 6-month cap fits the low end of the window only.
  4. **AWS / Microsoft / Google nonprofit grants.** Larger but slower, and each excludes schools. They depend on PNC being validated as an NGO, and for AWS and Microsoft on TechSoup or local availability in Cambodia.
- Cloudflare's free plan (DNS, TLS, proxy) can sit in front of any of these at no cost; Galileo is unnecessary for a test deployment.
- All credit programmes expire (6–12 months), most need a card or billing account, and charges start silently when credits run out. Set budget alerts.

### Gaps

- Approval times for DigitalOcean, Microsoft, Google and TechSoup: no 2025–2026 applicant reports found.
- Whether TechSoup (or any partner) validates Cambodian NGOs: TechSoup's country selector page could not be fetched (TLS error).
- No 2025–2026 first-hand reports from Cambodian NGOs applying to these programmes were found.
