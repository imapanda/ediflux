/**
 * Types of the canonical documents, version 1.
 *
 * Generated from contracts/canonical/v1/*.schema.json by src/generate-types.ts.
 * Do not edit: change the contract, then run `pnpm --filter @libredi/contracts generate`.
 * The tests fail when this file is out of date.
 */

export type CanonicalDocument = Order | OrderResponse | DespatchAdvice | Invoice;
/**
 * Whether a document is the first one, replaces an earlier one with the same number or cancels it. Absent means original.
 */
export type DocumentFunction = "original" | "replacement" | "cancellation";
/**
 * A document number, item number or other reference chosen by a partner.
 */
export type Identifier = string;
/**
 * A date, or a date and time with a UTC offset (RFC 3339). A mapping adds the offset of the partner when the message has none.
 */
export type Moment = string;
/**
 * A calendar date, YYYY-MM-DD.
 */
export type CalendarDate = string;
/**
 * Three upper-case letters (ISO 4217).
 */
export type CurrencyCode = string;
/**
 * Global Location Number, 13 digits. The check digit is verified by the validator, not by this schema.
 */
export type Gln = string;
export type Text = string;
/**
 * Two upper-case letters (ISO 3166-1 alpha-2).
 */
export type CountryCode = string;
/**
 * Free text, one entry per note.
 */
export type Notes = Text[];
/**
 * Position of a line in its document, starting at 1.
 */
export type LineNumber = number;
/**
 * Global Trade Item Number: 8, 12, 13 or 14 digits.
 */
export type Gtin = string;
/**
 * A decimal number written as text, so that no digit is lost: no exponent, no thousands separator, a point as decimal mark. Compare values as numbers: 5.5 and 5.50 are the same rate.
 */
export type Decimal = string;
/**
 * Unit of measure as a short upper-case code (UN/ECE Recommendation 20, for example PCE). The code list is not part of this schema.
 */
export type UnitCode = string;
/**
 * A decimal that cannot be negative: a price, a rate, the amount of a discount or a charge.
 */
export type UnsignedDecimal = string;
/**
 * Serial Shipping Container Code, 18 digits.
 */
export type Sscc = string;
/**
 * How a line is taxed. The rate tells apart the standard, reduced and other non-zero rates.
 */
export type TaxCategory =
  "standard" | "zero" | "exempt" | "reverseCharge" | "intraCommunity" | "export" | "notSubject";

/**
 * A purchase order from a buyer to a supplier (canonical document, version 1).
 */
export interface Order {
  documentType: "order";
  schemaVersion: 1;
  documentFunction?: DocumentFunction;
  documentNumber: Identifier;
  issueDate: Moment;
  requestedDeliveryDate?: CalendarDate;
  currency?: CurrencyCode;
  parties: {
    buyer: Party;
    supplier: Party;
    shipTo?: Party;
    invoicee?: Party;
  };
  references?: Reference[];
  notes?: Notes;
  /**
   * @minItems 1
   */
  lines: [OrderLine, ...OrderLine[]];
}
/**
 * A company or a location. The GLN is the usual key; other identifiers (VAT number, SIRET) go in `identifiers`.
 */
export interface Party {
  gln?: Gln;
  name?: Text;
  address?: Address;
  identifiers?: PartyIdentifier[];
}
export interface Address {
  street?: Text;
  city?: Text;
  postalCode?: Identifier;
  country?: CountryCode;
}
export interface PartyIdentifier {
  /**
   * Lower case name of the numbering scheme, for example vat or siret.
   */
  scheme: string;
  value: Identifier;
}
/**
 * A pointer to another document, a contract or any other reference carried by the message. `label` says what an `other` reference is.
 */
export interface Reference {
  type: "order" | "orderResponse" | "despatchAdvice" | "invoice" | "contract" | "other";
  value: Identifier;
  label?: Text;
  date?: CalendarDate;
}
/**
 * `quantity` is the ordered quantity.
 */
export interface OrderLine {
  lineNumber: LineNumber;
  product: Product;
  quantity: Quantity;
  unitPrice?: UnitPrice;
  requestedDeliveryDate?: CalendarDate;
  notes?: Notes;
}
/**
 * Identifies an item by at least one of its GTIN, the supplier's number, the buyer's number or its description.
 */
export interface Product {
  gtin?: Gtin;
  supplierItemId?: Identifier;
  buyerItemId?: Identifier;
  description?: Text;
}
export interface Quantity {
  value: Decimal;
  unit?: UnitCode;
}
/**
 * Net price of `basisQuantity` units (one unit when absent), in the currency of the document.
 */
export interface UnitPrice {
  amount: UnsignedDecimal;
  basisQuantity?: UnsignedDecimal;
}
/**
 * The answer of a supplier to an order: accepted, changed or rejected, as a whole and line by line (canonical document, version 1).
 */
export interface OrderResponse {
  documentType: "orderResponse";
  schemaVersion: 1;
  documentFunction?: DocumentFunction;
  documentNumber: Identifier;
  issueDate: Moment;
  responseStatus: "accepted" | "changed" | "rejected";
  confirmedDeliveryDate?: CalendarDate;
  currency?: CurrencyCode;
  parties: {
    buyer: Party;
    supplier: Party;
    shipTo?: Party;
  };
  /**
   * Includes the reference to the order that is answered.
   */
  references?: Reference[];
  notes?: Notes;
  /**
   * @minItems 1
   */
  lines: [OrderResponseLine, ...OrderResponseLine[]];
}
/**
 * `confirmedQuantity` is zero for a rejected line, and `unitPrice` is the confirmed price.
 */
export interface OrderResponseLine {
  lineNumber: LineNumber;
  product: Product;
  status: "accepted" | "changed" | "rejected";
  orderedQuantity?: Quantity;
  confirmedQuantity?: Quantity;
  unitPrice?: UnitPrice;
  notes?: Notes;
}
/**
 * A supplier's notice that goods are on their way: what is shipped, and optionally how it is packed, down to the SSCC of each logistic unit (canonical document, version 1).
 */
export interface DespatchAdvice {
  documentType: "despatchAdvice";
  schemaVersion: 1;
  documentFunction?: DocumentFunction;
  documentNumber: Identifier;
  issueDate: Moment;
  despatchDate?: Moment;
  estimatedDeliveryDate?: Moment;
  parties: {
    supplier: Party;
    buyer: Party;
    shipFrom?: Party;
    shipTo?: Party;
  };
  /**
   * Includes the orders that are delivered.
   */
  references?: Reference[];
  notes?: Notes;
  /**
   * @minItems 1
   */
  lines: [DespatchLine, ...DespatchLine[]];
  /**
   * The logistic units, outermost first. Their contents point at the lines above.
   */
  packages?: Package[];
}
/**
 * `quantity` is the despatched quantity.
 */
export interface DespatchLine {
  lineNumber: LineNumber;
  product: Product;
  quantity: Quantity;
  notes?: Notes;
}
/**
 * A logistic unit, with the lines it holds and the packages inside it (a pallet holding cartons).
 */
export interface Package {
  sscc?: Sscc;
  type?: "pallet" | "carton" | "container" | "other";
  contents?: PackageContent[];
  packages?: Package[];
}
/**
 * A quantity of the despatch line `lineNumber` held by the package.
 */
export interface PackageContent {
  lineNumber: LineNumber;
  quantity: Quantity;
  batchNumber?: Identifier;
  expiryDate?: CalendarDate;
}
/**
 * An invoice or a credit note, with its lines, taxes and totals (canonical document, version 1). Amounts of a credit note are positive: `invoiceKind` says which way they go.
 */
export interface Invoice {
  documentType: "invoice";
  schemaVersion: 1;
  invoiceKind: "invoice" | "creditNote";
  documentNumber: Identifier;
  issueDate: Moment;
  deliveryDate?: CalendarDate;
  currency: CurrencyCode;
  parties: {
    supplier: Party;
    buyer: Party;
    invoicee?: Party;
    shipTo?: Party;
  };
  /**
   * Includes the orders and despatch advices that are invoiced, and the invoice a credit note corrects.
   */
  references?: Reference[];
  payment?: {
    dueDate?: CalendarDate;
    terms?: Text;
    iban?: string;
  };
  notes?: Notes;
  /**
   * @minItems 1
   */
  lines: [InvoiceLine, ...InvoiceLine[]];
  /**
   * Discounts and charges on the whole invoice.
   */
  adjustments?: Adjustment[];
  /**
   * One entry per tax category and rate.
   *
   * @minItems 1
   */
  taxSubtotals: [TaxSubtotal, ...TaxSubtotal[]];
  /**
   * `netTotal` adds the lines and the adjustments, without tax; `grossTotal` adds the tax; `payableAmount` is the gross total minus `prepaidAmount`.
   */
  totals: {
    netTotal: Decimal;
    taxTotal: Decimal;
    grossTotal: Decimal;
    prepaidAmount?: Decimal;
    payableAmount: Decimal;
  };
}
/**
 * `lineAmount` is the quantity times the price, after the line adjustments, without tax.
 */
export interface InvoiceLine {
  lineNumber: LineNumber;
  product: Product;
  quantity: Quantity;
  unitPrice: UnitPrice;
  adjustments?: Adjustment[];
  lineAmount: Decimal;
  tax: Tax;
  notes?: Notes;
}
/**
 * A discount (allowance) or an extra cost (charge) on a line or on the whole document. The amount is positive.
 */
export interface Adjustment {
  kind: "allowance" | "charge";
  amount: UnsignedDecimal;
  reason?: Text;
  tax?: Tax;
}
/**
 * The tax category and its rate in percent, for example 20 or 5.5.
 */
export interface Tax {
  category: TaxCategory;
  rate?: UnsignedDecimal;
}
export interface TaxSubtotal {
  category: TaxCategory;
  rate?: UnsignedDecimal;
  taxableAmount: Decimal;
  taxAmount: Decimal;
  exemptionReason?: Text;
}
