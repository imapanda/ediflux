# Canonical documents

Libredi's neutral model of the four business documents a trading relationship needs. A partner
mapping turns a message into one of them and an ERP export reads one, so the two sides never
meet directly and a new partner or a new ERP format costs one mapping, not one per pair (see
[architecture](../../docs/architecture.md) and
[ADR 6](../../docs/adr/0006-declarative-mappings-with-jsonata.md)).

| Document | Schema | Example | Carries |
| --- | --- | --- | --- |
| Order | [`order.schema.json`](v1/order.schema.json) | [`order.json`](v1/examples/order.json) | Parties, requested delivery date, references, lines with product, quantity and price |
| Order response | [`order-response.schema.json`](v1/order-response.schema.json) | [`order-response.json`](v1/examples/order-response.json) | Accepted, changed or rejected as a whole and per line, with ordered and confirmed quantities and the confirmed price |
| Despatch advice | [`despatch-advice.schema.json`](v1/despatch-advice.schema.json) | [`despatch-advice.json`](v1/examples/despatch-advice.json) | Despatched lines and, optionally, the nested logistic units with their SSCC, contents and batch numbers |
| Invoice and credit note | [`invoice.schema.json`](v1/invoice.schema.json) | [`invoice.json`](v1/examples/invoice.json) | Lines, discounts and charges, tax per category and rate, totals, payment terms |

[`common.schema.json`](v1/common.schema.json) holds what they share: party, address,
reference, product, quantity, price, tax, adjustment and package. All schemas are JSON Schema
2020-12. The examples mirror the [sample corpus](../../samples/edifact/README.md) where it has a
message of the same kind, and a test checks that they carry the same parties, products and
SSCC. Everything in them is fictitious.

## Conventions

- **Closed objects.** An unknown property is an error, so that a misspelled field in a mapping
  fails its fixtures instead of vanishing.
- **Numbers are decimal strings** (`"12"`, `"2.50"`): no digit is lost on the way, whatever
  the language of the reader. Quantities, prices, rates and amounts all use them; compare
  them as numbers (`"5.5"` and `"5.50"` are the same rate). Prices, rates and the amounts of
  discounts and charges cannot be negative. A credit note keeps positive amounts:
  `invoiceKind` says which way they go.
- **Dates** are `YYYY-MM-DD`. Where a time can matter (`issueDate`, `despatchDate`,
  `estimatedDeliveryDate`) a date-time with a UTC offset is also accepted: a mapping adds the
  offset of the partner when its message has none.
- **Identifiers** are GLN (13 digits), GTIN (8, 12, 13 or 14) and SSCC (18). The schemas check
  the shape, not the check digit nor arithmetic such as "the lines add up to the total"; the
  validator does.
- **Codes** are short upper-case strings (`EUR`, `FR`, `PCE`). The schemas do not list them:
  they are not ours to copy (see the
  [standards licensing decision](../../docs/adr/0007-standards-licensing.md)). Concepts that
  matter to the logic, such as the response status or the tax category, are Libredi's own small
  enumerations, which a mapping fills from the partner's codes with a lookup table.
- **Parties** are named by role (`buyer`, `supplier`, `shipTo`, ...), each with a GLN, a name,
  an address and extra identifiers such as `vat` or `siret`.
- **Function.** An order, an order response or a despatch advice may say it replaces an earlier
  document of the same number or cancels it (`documentFunction`); absent means original.
- **Resolving `$ref`.** Schemas refer to each other by relative path, and their `$id` is a
  name, not an address to fetch. A validator must load every file of `v1/` from disk (or from
  the release) and never resolve a reference over the network.
- **References** link documents (`order`, `despatchAdvice`, ...); the `api` follows them to
  chain an order, its response, its despatch advice and its invoice.

## Versioning

A document says which schema it follows: `"documentType": "order", "schemaVersion": 1`. The
schemas of a version live in `contracts/canonical/v<N>/` and their `$id` contains it.

- **Within a version**, only compatible changes: add an optional property or definition, or
  relax a constraint.
- **A new major version** is needed to remove or rename a property, make one required, tighten
  a constraint or add a value to an enumeration. It is published in `v2/` next to `v1/`, which
  stays until no mapping targets it.
- **Closed objects and compatibility.** A validator knows the schema of its own Libredi
  release, so it rejects a property added by a later release: a mapping that uses a new optional
  property needs that release or a newer one. Code that only reads documents ignores the
  properties it does not know.
- **A mapping targets one version** (see the [mapping format](../mapping/README.md)). Moving a
  partner to version 2 means a new mapping version that passes its fixtures; nothing converts
  documents behind its back.

## TypeScript types

The types are generated from the schemas into
[`packages/contracts`](../../packages/contracts/src/generated/canonical-v1.ts) and imported as
`@libredi/contracts/canonical/v1` (a version 2 will get its own path, so both can coexist):

```ts
import type { Order } from "@libredi/contracts/canonical/v1";
```

After changing a schema, regenerate and commit the result:

```bash
pnpm --filter @libredi/contracts generate
```

The CI regenerates the types in memory and fails when the committed file differs, so the types
cannot drift from the schemas. Go types come with the generated clients of issue #182.

## Changing a schema

1. Change the schema, then the example that shows it. Examples contain fictitious data only.
2. Add a test in [`canonical.test.ts`](../../packages/contracts/src/canonical.test.ts) for a new
   rule: one example that must pass and one broken variant that must fail.
3. Regenerate the types (above) and run `pnpm verify`.
4. Respect the versioning rules above; a breaking change needs its own version directory.
