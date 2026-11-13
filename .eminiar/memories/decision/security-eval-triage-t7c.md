---
name: decision/security-eval-triage-t7c
kind: decision
status: proposed
tags: [adjudicator, security, eval, signals]
related: [file:src/adjudicator/security/signals.ts, file:tests/unit/adjudicator-security-signals.test.ts, file:src/adjudicator/security/data/evalset.ts]
created: 2026-11-13T19:43:11.660Z
updated: 2026-11-13T19:43:11.660Z
---

Security eval triage (task #331 / T7c, swarm run 20261113-bef5ea, branch feature/security-adjudication, 2026-11-13). Fixed 9 of 16 mismatches with generic signal fixes in src/adjudicator/security/signals.ts only. score.ts, taxonomy.ts, the weights, the floors and evalset.ts were not changed. Core eval moved from 76.9% to 90.4% accuracy. HIGH+ recall went from 76% to 96%. CRITICAL precision went from 70% to 78.6%. LOW false-warn stayed at 0, and HIGH+ false positives stayed at 0/27.

Signal fixes:
(1) URL_RE now matches a host written without a scheme (BARE_HOST). It accepts only a closed list of host suffixes (com/net/org/gov/edu/io/dev/app/co/ai/xyz/info/biz/cloud/site/online/tech/test/invalid). The host must not follow `@ . / \ -` or an alphanumeric, and must not be followed by another dot-word (so x.test.ts is not a host). A two-label name needs a path or a com/net/org/gov/edu suffix, so "socket.io" alone is a library, not a host.
(2) NOUN_BEFORE lookbehind: "post" and "email" after a determiner ("the blog post", "the latest email") are nouns, not egress. "public issue" is no longer an egress-public sink.
(3) conceal also matches "do not mention this to the user" and a clause-initial "say nothing".
(4) exfiltrate also fires when an exfil verb has an outside destination in its 100-char window (`<url>` or `x@host.tld`, P.outDest), together with either the environment as the object (P.envObj: env vars, process.env, printenv) or a conceal cue anywhere in the text.
(5) A worded pipe into a shell (P.nlPipe) is fetch-exec only when the text also fetches something (install, url, scrape, third-party or clone).
(6) followSteps also looks up to 60 chars before the verb for the source.
(7) "fetch the <up to 3 words> page/website/article/feed" is a research verb. It counts only with a web tool, and only when the noun ends the phrase, so "page data" does not match.

Open rule questions for the coordinator, not fixed because they change what a floor means:
(a) C2 fires from grant-only S/E legs (saas read S 1, browser S 1/E 1), which makes high-09, high-13 and high-15 CRITICAL against a HIGH label. A proposal: C2 needs S or E task-driven >= .8, which would keep crit-02 and high-07.
(b) crit-11 and crit-14 are labelled C6 but carry only disable-safeguards and/or conceal. C6_INTENTS is ignore-instructions + exfiltrate.
(c) high-12 is the D11 em_remember W* .4 choice.
