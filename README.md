# Ediflux

**Open-source EDI gateway: receive, translate and send business messages, reliably.**

Ediflux receives EDI messages from your trading partners, translates them into the
formats your ERP understands (CSV, JSON, XML…), and sends your own documents back the
other way. It is built as a set of Docker services that you can run yourself, for free.

> **Status: early design.** Nothing is usable yet. Follow the
> [roadmap](https://github.com/imapanda/ediflux/milestones) and the
> [discussions](https://github.com/imapanda/ediflux/discussions) to see where we are going.

## Why

Small and mid-sized companies often pay an EDI provider for every message they exchange
(orders, despatch advices, invoices…). The open-source alternatives exist but are hard to
configure. Ediflux aims to be the simple, reliable one.

## Planned features

- **Formats**: UN/EDIFACT and EANCOM first, then ANSI X12; CSV, JSON and XML on the ERP side.
- **Transports**: SFTP/FTP folders, HTTP API, AS2, email; more later.
- **Reliability first**: every raw message archived, idempotent processing, retries,
  replay, acknowledgements (CONTRL, APERAK), full audit trail.
- **Environments**: separate test and production setups per partner, so you can validate
  a new flow before going live.
- **AI-assisted onboarding**: an MCP server that lets an AI assistant read a partner's
  specification sheet (message implementation guide) and draft the matching mapping.
- **Self-hosted or hosted**: run it on your own server with Docker Compose, or use a
  managed instance.

## License

Ediflux is free software, licensed under the [GNU Affero General Public License v3.0](LICENSE).
