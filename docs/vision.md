# Vision

## The problem

Companies that trade with large retailers, distributors or manufacturers must exchange
business documents electronically: purchase orders, order responses, despatch advices,
invoices. The usual standard in Europe is **UN/EDIFACT** (often its GS1 subset
**EANCOM**); in North America it is **ANSI X12**.

Most small and mid-sized companies do not run EDI themselves. They pay a provider that
receives the partner's messages, converts them into a file their ERP can import (often
CSV), and does the reverse for outgoing documents. Typical prices are a fixed fee plus
**tens of cents per message**, which adds up quickly for a supplier receiving hundreds of
orders a month.

Open-source alternatives exist (Bots EDI, Smooks, mescedia…), but they are toolkits for
integration specialists: hard to install, hard to configure, and with little help when a
message fails at 3 a.m.

## What Ediflux is

A **self-hostable EDI gateway** that a small IT team (or a single ERP admin) can install
with Docker Compose and operate with confidence:

1. **Receive** messages from partners over the transport they impose (SFTP/FTP, AS2,
   HTTP, email).
2. **Translate** them: parse and validate EDIFACT/X12, map them to a clear canonical
   document (order, despatch advice, invoice), and export what the ERP expects (CSV,
   JSON, XML, fixed-width).
3. **Send** documents back: read the ERP export, build valid EDI messages with correct
   envelopes and numbering, deliver them, and track acknowledgements.
4. **Show** everything: each message, its state, its errors in plain language, and a
   one-click replay.

## Principles

1. **Reliability first.** No message is ever lost or silently duplicated. Raw messages are
   archived before anything else happens, every step is idempotent and replayable, and
   every failure is visible and alerted.
2. **Test before production.** Each partner flow has a test environment and a production
   environment with separate configuration, numbering and data. A flow goes live only
   after its test samples pass.
3. **Simple to run.** One `docker compose up` for a complete instance; sensible defaults;
   no integration-engine expertise required.
4. **Declarative, reviewable mappings.** Mappings are versioned data files with sample-based
   tests, not arbitrary code. A human can read them; a machine can generate them.
5. **AI-assisted, human-approved.** An MCP server lets an AI assistant read a partner's
   specification sheet, draft the mapping, run it on samples and explain errors. Drafts
   land in the test environment; a human promotes them to production.
6. **Formats and transports are separate.** How a file travels (SFTP, AS2…) and what it
   contains (EDIFACT, X12…) are independent plug-ins.
7. **Open source, hosted option.** Everything needed to run Ediflux is AGPL-3.0. A managed
   hosting offer may exist for those who do not want to operate it.

## Non-goals (for now)

- Being a French e-invoicing "plateforme agréée" (PA). Ediflux can prepare and route
  invoices but does not replace a registered platform.
- Replacing an ERP, a WMS or a TMS: Ediflux moves and translates documents, it does not
  manage orders or stock.
- Business-logic microservices: services are split along technical lines (transport,
  translation, orchestration, UI, MCP), not by business domain.

## First target user

A manufacturer or wholesaler that receives **ORDERS** from distributors over SFTP or AS2,
imports them into its ERP as CSV, and sends back **ORDRSP**, **DESADV** and **INVOIC**.
The first milestone that delivers value: converting real inbound orders into the CSV the
ERP already imports, with no per-message fee.
