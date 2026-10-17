# Research: open-source landscape and building blocks

> Research snapshot of **2026-10-17** (GitHub/GitLab metadata read through their APIs).
> Facts marked *(unverified)* could not be confirmed on a primary source.

## 1. Bots EDI: what to learn

- **Alive line**: Bots NG on GitLab (`bots-ediint/bots`), GPL-3.0, Python/Django,
  `4.0.0rc4` (2026-09-05). The GitHub repo `bots-edi/bots` is archived (2025-09-30); the
  original 3.2 "Frozen" line needs Python 2.7.
- **Architecture**: Django + SQLite by default; a batch `bots-engine` next to a separate
  monitor UI; models `channel`, `routes`, `translate`, `partner`, `confirmrule` (each with
  ~14–30 fields); grammars as Python dicts; **mappings as arbitrary Python scripts**; seven
  user-code folders; no built-in AS2.
- **Why it is hard**: one flow needs a rule, two grammars, a mapping script, a route, two
  channels, partners and confirm rules (the official recipe is ~9 steps and warns that "the
  learning curve is a little steep"); writing grammars "can be the most difficult part";
  mappings are debugged with print statements and cannot be reviewed, sandboxed or checked
  by a tool; documentation for NG is "work in progress"; fork confusion.
- **Ideas worth keeping**: CONTRL/997 confirm rules, test-to-production change management,
  per-file lineage, re-receive/re-send, code-conversion tables, partner-specific syntax
  overrides, plugin export/import.
- **Avoid**: code as mappings, hand-written grammars, batch engine + separate UI, 30-field
  configuration forms.
- `bots-grammars` (GPL-3.0) holds EDIFACT grammars for D93A–D24A "generated from UN docs";
  usable as a cross-check, but files stay GPL and the UN licence question (see
  [standards](standards.md)) still applies.

## 2. Complete open-source EDI products

| Name | Language | Licence | Status | Verdict |
|---|---|---|---|---|
| Bots NG | Python/Django | GPL-3.0 | active (rc) | learn from (UX is the cautionary tale) |
| mescedia-core | Java (Camel, Daffodil, Smooks) | Apache-2.0 / LGPL | archived, last code 2023 | learn from |
| Smooks + EDI cartridge | Java | Apache-2.0 / LGPL | v2.2.1 (2025-02), low activity | avoid: DFDL schemas to author |
| Apache Camel | Java | Apache-2.0 | very active | learn from: framework, no EDI dictionary |
| Daffodil + DFDLSchemas/EDIFACT | Scala | Apache-2.0 | schemas cover D03B, 7 messages | avoid |
| BlueSeer | Java | MIT | v8.0 (2026-06) | learn from: ERP with embedded EDI |
| OCA/edi (Odoo) | Python | AGPL-3.0 | active | learn from: exchange-record pattern |

No credible open-core EDI gateway launched in 2023–2026: new entrants have fewer than
20 stars.

## 3. Parsing and validation libraries

| Name | Language | Licence | Notes | Verdict |
|---|---|---|---|---|
| StAEDI | Java | Apache-2.0 | Streaming X12/EDIFACT/TRADACOMS with schema validation; ships envelope schemas only | **test oracle in CI** |
| EDIReader | Java | GPL-3.0 | SAX parser, no directory validation *(unverified)* | oracle / learn from |
| pydifact | Python | MIT | tokenizer/serializer, API unstable | avoid as core |
| pyx12 | Python | BSD | X12/HIPAA validator with 997/999 | learn from |
| @ediflow/core | TypeScript | MIT | claims D96A/D01B/EANCOM 2002, created 2026-01 | evaluate |
| ts-edifact | TypeScript | Apache-2.0 | generates specs from UNECE; no code-list validation | learn from |
| node-edifact | JavaScript | Apache-2.0 | abandoned (2021) | avoid |
| omniparser | Go | MIT | streaming transforms, non-validating EDI reader | learn from |
| php-edifact-mapping | PHP | LGPL-3.0 | mapping XMLs D94B–D24A rebuilt from UNTDID | cross-check data |
| Ballerina EDI | Ballerina | Apache-2.0 | JSON-schema driven, generated from UNECE zips | learn from |
| EdiFabric | .NET (+ bindings) | commercial | $179–799/yr, OEM +$4,500/yr | avoid (lock-in) |

**Conclusion**: no ecosystem ships validated message-level EDIFACT definitions. Ediflux
will generate its definition registry from the UN directories at install time and write
its own parser/validator, checked against StAEDI in CI.

## 4. Transport building blocks

| Name | Language | Licence | Notes | Verdict |
|---|---|---|---|---|
| **SFTPGo** | Go | AGPL-3.0 + additional terms | SFTP/FTPS/WebDAV/HTTP, S3/GCS/Azure backends, REST API, event manager with upload hooks; very active (12.6k stars) | **wrap as `sftp-gateway`** |
| OpenAS2 | Java | GPL-3.0 | RFC 4130, sync/async MDN, sign/encrypt/compress, Docker, active (v4.14, 2026-10) | wrap as container |
| phase2 | Java | FreeBSD / Apache-2.0 | library-first AS2, active | wrap (custom service) |
| phase4 | Java | Apache-2.0 | AS4 and Peppol | later |
| Holodeck B2B | Java | GPL-3.0 | AS4 gateway | if AS4 is needed |
| pyas2-lib | Python | GPL-3.0 | slow-moving | learn from |
| atmoz/sftp | Shell | MIT | plain SFTP, no events | optional |
| OFTP2 | — | — | hobby-level code only | partner or skip |

SFTPGo's NOTICE requires attribution and a link to the corresponding source when it is
offered over a network, even unmodified: relevant for the hosted offer.

## 5. Reliability backbone

| Option | Verdict | Reason |
|---|---|---|
| **PostgreSQL + pg-boss** (Node, MIT) | **recommended** | No extra container; `SKIP LOCKED`; retries with backoff, dead-letter with redrive, cron, archive for replay |
| graphile-worker (Node) | alternative | pre-1.0 |
| River (Go, MPL-2.0) | alternative if Go | some features in paid Pro |
| Procrastinate (Python) | alternative if Python | seeking maintainers |
| DBOS Transact | watch | Postgres-backed durable workflows |
| NATS JetStream, RabbitMQ, Kafka | avoid for v1 | extra stateful broker |
| Temporal | avoid for v1 | server + DB + UI to operate |
| Restate | avoid | BSL licence, hosting restriction |

## 6. Mapping engines

| Option | Verdict | Reason |
|---|---|---|
| **JSONata** (JS reference; Java, Go, Rust, Python ports) | **recommended** | Pure expression language with no I/O; easy for an LLM to write and for a human to review field by field; Stedi uses it for its mappings |
| jq | alternative | terse, harder to review |
| XSLT 3 | avoid | XML-centric and verbose |
| Python/JS scripts (Bots style) | avoid | arbitrary code, cannot be sandboxed |
| CEL / Starlark / Wasm | fallback | conditions or a sandboxed escape hatch |

Guards: disable `$eval`, limit time, recursion depth and memory; mappings are one-way, so
inbound and outbound flows each have their own.

## 7. Market and the AI angle

- **Prices**: QUICK EDI (French SaaS for retail suppliers) €49.90–79.90/month for up to
  100 orders; Orderful from $189/month per partner; managed EDI typically $550–650/month
  for 5 partners plus setup; legacy providers $0.10–1.00 per document plus VAN fees
  (vendor figures).
- **AI mapping**: AWS B2B Data Interchange generates mapping code from sample documents
  (since 2024-11); Comarch describes agent-based mapping with per-rule confidence levels and
  human acceptance of low-confidence rules.
- **MCP servers for EDI**: a handful of small projects (Stedi healthcare only, StateSet
  `edi-mcp`, several 0-star repos). **None reads a partner's implementation guide to draft
  a mapping**: that is Ediflux's opening.
- **Caution**: standards and partner specifications are licensed or confidential. Treat
  them as private tenant data and let users bring their own model key.

## Sources

Main sources: [Bots NG](https://gitlab.com/bots-ediint/bots), [bots-grammars](https://gitlab.com/bots-ediint/bots-grammars),
[Bots docs](https://bots.readthedocs.io/en/latest/), [mescedia](https://github.com/mescedia/mescedia-core),
[Smooks EDI cartridge](https://github.com/smooks/smooks-edi-cartridge), [StAEDI](https://github.com/xlate/staedi),
[EDIReader](https://github.com/BerryWorksSoftware/edireader), [pydifact](https://github.com/nerdocs/pydifact),
[ts-edifact](https://github.com/RovoMe/ts-edifact), [@ediflow/core](https://github.com/ediflow-lib/core),
[php-edifact-mapping](https://github.com/php-edifact/edifact-mapping), [omniparser](https://github.com/jf-tech/omniparser),
[EdiFabric pricing](https://www.edifabric.com/pricing.html), [SFTPGo](https://github.com/drakkan/sftpgo)
([NOTICE](https://github.com/drakkan/sftpgo/blob/main/NOTICE)), [OpenAS2](https://github.com/OpenAS2/OpenAs2App),
[phase2](https://github.com/phax/phase2), [phase4](https://github.com/phax/phase4),
[pg-boss](https://github.com/timgit/pg-boss), [River](https://github.com/riverqueue/river),
[graphile-worker](https://github.com/graphile/worker), [Temporal](https://github.com/temporalio/temporal),
[Restate](https://github.com/restatedev/restate), [JSONata](https://github.com/jsonata-js/jsonata),
[Stedi mappings](https://www.stedi.com/docs/edi-platform/mappings), [QUICK EDI](https://quickedi.fr/),
[Orderful pricing](https://www.orderful.com/pricing), [Foundational pricing](https://getfoundational.com/pricing/),
[AWS B2B Data Interchange AI mappings](https://aws.amazon.com/about-aws/whats-new/2024/11/aws-b2b-data-interchange-generative-ai-assisted-edi-mappings),
[Comarch AI mapping](https://www.comarch.com/trade-and-services/data-management/news/ai-orchestration-in-e-invoicing-and-edi-document-mapping/),
[The MCP EDI vacuum](https://transactions.dev/blog/the-mcp-edi-vacuum/).
