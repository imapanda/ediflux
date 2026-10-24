import type { DataElementView, NodeView, PositionView, RegistryView } from "../registry.ts";

/*
 * Two hand-written registries for the tests, one for each directory of the sample corpus (D.96A
 * and D.01B), with just the segments the corpus uses. They are NOT the UN/EDIFACT directories and
 * are not derived from them: the names are invented ("Test ..."), the lengths and the structures
 * are the least that makes the 24 valid samples valid and the invalid ones invalid, and the one
 * code list has the three codes the corpus uses. Real registries are generated on the operator's
 * machine and never committed (ADR 7); a test that needs one reads it from a path the developer
 * gives (see registry.real.test.ts).
 *
 * The tags of data elements, composites and segments are the identifiers that ISO 9735 and the
 * corpus use, because the positions of an error are given in them.
 */

const element = (
  name: string,
  type: DataElementView["type"],
  min: number,
  max: number,
  codeList?: string,
): DataElementView => ({
  name: `Test ${name}`,
  type,
  minLength: min,
  maxLength: max,
  ...(codeList === undefined ? {} : { codeList }),
});

const M = (ref: string, maxOccurs?: number): PositionView => ({
  ref,
  status: "M",
  ...(maxOccurs === undefined ? {} : { maxOccurs }),
});
const C = (ref: string, maxOccurs?: number): PositionView => ({
  ref,
  status: "C",
  ...(maxOccurs === undefined ? {} : { maxOccurs }),
});

const seg = (tag: string, status: "M" | "C", maxOccurs = 1): NodeView => ({
  kind: "segment",
  tag,
  status,
  maxOccurs,
});
const group = (
  id: string,
  trigger: string,
  maxOccurs: number,
  nodes: NodeView[] = [],
): NodeView => ({ kind: "group", id, status: "C", maxOccurs, trigger: { tag: trigger }, nodes });

const dataElements: Record<string, DataElementView> = {
  "0081": element("section code", "a", 1, 1),
  "1000": element("document name", "an", 1, 35),
  "1001": element("document name code", "an", 1, 3),
  "1004": element("document identifier", "an", 1, 35),
  "1056": element("version", "an", 1, 9),
  "1060": element("revision", "an", 1, 6),
  "1082": element("line number", "n", 1, 6),
  "1131": element("code list qualifier", "an", 1, 3),
  "1153": element("reference qualifier", "an", 1, 3),
  "1154": element("reference number", "an", 1, 35),
  "1225": element("message function", "an", 1, 3),
  "1229": element("action", "an", 1, 3),
  "2005": element("date qualifier", "an", 1, 3),
  "2379": element("date format", "an", 1, 3),
  "2380": element("date value", "an", 1, 35),
  "3035": element("party qualifier", "an", 1, 3, "3035"),
  "3036": element("party name", "an", 1, 35),
  "3039": element("party identifier", "an", 1, 35),
  "3042": element("street line", "an", 1, 35),
  "3045": element("name format", "an", 1, 3),
  "3055": element("responsible agency", "an", 1, 3),
  "3124": element("address line", "an", 1, 35),
  "3164": element("city", "an", 1, 35),
  "3207": element("country", "an", 1, 3),
  "3229": element("region", "an", 1, 9),
  "3251": element("postal code", "an", 1, 9),
  "3453": element("language", "an", 1, 3),
  "4233": element("marking instruction", "an", 1, 3),
  "4343": element("response type", "an", 1, 3),
  "4347": element("product identification function", "an", 1, 3),
  "4440": element("free text", "an", 1, 512),
  "4441": element("text reference", "an", 1, 17),
  "4451": element("text subject", "an", 1, 3),
  "4453": element("text function", "an", 1, 3),
  "5118": element("price", "n", 1, 15),
  "5125": element("price qualifier", "an", 1, 3),
  "5375": element("price type", "an", 1, 3),
  "6060": element("quantity", "an", 1, 35),
  "6063": element("quantity qualifier", "an", 1, 3),
  "6066": element("control value", "an", 1, 18),
  "6069": element("control qualifier", "an", 1, 3),
  "6343": element("currency type", "an", 1, 3),
  "6345": element("currency", "an", 1, 3),
  "6347": element("currency usage", "an", 1, 3),
  "6411": element("unit", "an", 1, 3),
  "7008": element("item description", "an", 1, 256),
  "7009": element("item description code", "an", 1, 17),
  "7064": element("packaging type description", "an", 1, 35),
  "7065": element("packaging type", "an", 1, 17),
  "7077": element("description format", "an", 1, 3),
  "7075": element("packaging level", "an", 1, 3),
  "7081": element("item characteristic", "an", 1, 3),
  "7140": element("item number", "an", 1, 35),
  "7143": element("item number type", "an", 1, 3),
  "7164": element("hierarchical identifier", "an", 1, 12),
  "7166": element("hierarchical parent", "an", 1, 12),
  "7224": element("package count", "n", 1, 8),
  "7402": element("identity number", "an", 1, 35),
  "7405": element("identity type", "an", 1, 3),
};

const composites: RegistryView["composites"] = {
  C002: { name: "Test document name", components: [C("1001"), C("1131"), C("3055"), C("1000")] },
  C058: { name: "Test name and address", components: [C("3124")] },
  C059: { name: "Test street", components: [M("3042"), C("3042"), C("3042"), C("3042")] },
  C080: {
    name: "Test party name",
    components: [M("3036"), C("3036"), C("3036"), C("3036"), C("3036"), C("3045")],
  },
  C082: { name: "Test party identification", components: [M("3039"), C("1131"), C("3055")] },
  C106: { name: "Test document identification", components: [C("1004"), C("1056"), C("1060")] },
  C107: { name: "Test text reference", components: [C("4441"), C("1131"), C("3055")] },
  C108: {
    name: "Test text literal",
    components: [M("4440"), C("4440"), C("4440"), C("4440"), C("4440")],
  },
  C186: { name: "Test quantity details", components: [M("6063"), M("6060"), C("6411")] },
  C202: {
    name: "Test package type",
    components: [C("7065"), C("1131"), C("3055"), C("7064")],
  },
  C208: { name: "Test identity numbers", components: [M("7402"), C("7402")] },
  C212: {
    name: "Test item number identification",
    components: [C("7140"), C("7143"), C("1131"), C("3055")],
  },
  C270: { name: "Test control", components: [M("6069"), C("6066"), C("6411")] },
  C273: {
    name: "Test item description",
    components: [C("7009"), C("1131"), C("3055"), C("7008"), C("7008")],
  },
  C504: { name: "Test currency details", components: [M("6347"), C("6345"), C("6343")] },
  C531: { name: "Test packaging details", components: [C("7075")] },
  C506: { name: "Test reference", components: [M("1153"), C("1154"), C("1060")] },
  C507: { name: "Test date and time", components: [M("2005"), C("2380"), C("2379")] },
  C509: { name: "Test price information", components: [M("5125"), C("5118"), C("5375")] },
  C819: { name: "Test country subdivision", components: [C("3229")] },
  C829: { name: "Test sub-line", components: [C("1082")] },
};

const segments = (repeatedText: number): RegistryView["segments"] => ({
  BGM: {
    name: "Test beginning of message",
    elements: [C("C002"), C("C106"), C("1225"), C("4343")],
  },
  CNT: { name: "Test control total", elements: [M("C270")] },
  CPS: { name: "Test hierarchy", elements: [M("7164"), C("7166")] },
  CUX: { name: "Test currencies", elements: [C("C504"), C("C504")] },
  DTM: { name: "Test date", elements: [M("C507")] },
  FTX: {
    name: "Test free text",
    elements: [M("4451"), C("4453"), C("C107"), C("C108", repeatedText), C("3453")],
  },
  GIN: { name: "Test identity", elements: [M("7405"), M("C208"), C("C208")] },
  IMD: { name: "Test item description", elements: [C("7077"), C("7081"), C("C273")] },
  LIN: { name: "Test line", elements: [C("1082"), C("1229"), C("C212"), C("C829")] },
  NAD: {
    name: "Test party",
    elements: [
      C("3035"),
      C("C082"),
      C("C058"),
      C("C080"),
      C("C059"),
      C("3164"),
      C("C819"),
      C("3251"),
      C("3207"),
    ],
  },
  PAC: { name: "Test package", elements: [C("7224"), C("C531"), C("C202")] },
  PCI: { name: "Test marking", elements: [C("4233")] },
  PIA: {
    name: "Test additional product id",
    elements: [M("4347"), M("C212"), C("C212"), C("C212"), C("C212"), C("C212")],
  },
  PRI: { name: "Test price", elements: [C("C509")] },
  QTY: { name: "Test quantity", elements: [M("C186")] },
  RFF: { name: "Test reference", elements: [M("C506")] },
  UNS: { name: "Test section control", elements: [M("0081")] },
});

const codeLists: RegistryView["codeLists"] = {
  "3035": {
    closed: true,
    codes: {
      BY: { name: "Test buyer" },
      DP: { name: "Test delivery party" },
      SU: { name: "Test supplier" },
    },
  },
};

const header = [seg("BGM", "M"), seg("DTM", "C", 35)];
const parties = [group("SG2", "NAD", 99, [group("SG3", "RFF", 9)])];
const trailer = [seg("UNS", "M"), seg("CNT", "C", 10)];

const messages: RegistryView["messages"] = {
  ORDERS: {
    nodes: [
      ...header,
      seg("FTX", "C", 99),
      group("SG1", "RFF", 10, [seg("DTM", "C", 5)]),
      ...parties,
      group("SG7", "CUX", 5, [seg("DTM", "C", 5)]),
      group("SG28", "LIN", 9999, [
        seg("PIA", "C", 25),
        seg("IMD", "C", 99),
        seg("QTY", "C", 99),
        seg("PRI", "C", 25),
      ]),
      ...trailer,
    ],
  },
  ORDRSP: {
    nodes: [
      ...header,
      group("SG1", "RFF", 10, [seg("DTM", "C", 5)]),
      ...parties,
      group("SG27", "LIN", 9999, [seg("QTY", "C", 99), seg("PRI", "C", 25)]),
      ...trailer,
    ],
  },
  DESADV: {
    nodes: [
      seg("BGM", "M"),
      seg("DTM", "C", 10),
      seg("FTX", "C", 99),
      group("SG1", "RFF", 9),
      ...parties,
      group("SG10", "CPS", 9999, [
        group("SG11", "PAC", 99, [group("SG13", "PCI", 99, [seg("GIN", "C", 99)])]),
        group("SG15", "LIN", 9999, [seg("QTY", "C", 99), seg("GIN", "C", 99)]),
      ]),
      seg("CNT", "C", 10),
    ],
  },
};

function registry(release: "96A" | "01B"): RegistryView {
  return {
    directory: { agency: "UN", version: "D", release },
    dataElements,
    composites,
    // D.01B is given a more generous FTX for the sample that repeats its text element.
    segments: segments(release === "01B" ? 5 : 1),
    codeLists,
    messages,
  };
}

/** The registries of the two directories of the corpus. */
export const corpusRegistries: readonly RegistryView[] = [registry("96A"), registry("01B")];
