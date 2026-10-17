# Ediflux

[![CI](https://github.com/imapanda/ediflux/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/imapanda/ediflux/actions/workflows/ci.yml)
[![CodeQL](https://github.com/imapanda/ediflux/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/imapanda/ediflux/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/imapanda/ediflux/badge)](https://scorecard.dev/viewer/?uri=github.com/imapanda/ediflux)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are proposed, checked and released, and
[SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

Ediflux is free software, licensed under the [GNU Affero General Public License v3.0](LICENSE).
