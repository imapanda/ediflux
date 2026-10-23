/** The UN/EDIFACT directories the registry generator can build, and where to find them. */
export interface DirectoryPin {
  /** Name of the directory as the operator writes it: `D01B`. */
  id: string;
  /** The `version` and `release` of the UNH message identifier (S009). */
  version: string;
  release: string;
  /** ISO 9735 syntax versions the directory is used with. */
  syntaxVersions: number[];
  /** Name of the file at UNECE, and the file name an operator supplies in offline mode. */
  fileName: string;
  url: string;
  /** SHA-256 of that file, in lower-case hexadecimal. A file with another checksum is refused. */
  sha256: string;
  /**
   * What the directory calls its parts. The archive holds one inner archive per part, named
   * `<name>.ZIP`, with the files of the part inside, whose names end in `.<release>`.
   */
  parts: {
    elements: string;
    composites: string;
    segments: string;
    /** One file per message, named `<TYPE>_D.<release>`. */
    messages: string;
    /** One or more files named `<name>*.<release>`. */
    codes: string;
  };
  /** Column where a code list puts the name of a code, after the code itself. */
  codeNameColumn: number;
}

// The checksums were computed on 2026-10-24 from the copies of these files kept by the Internet
// Archive, because unece.org answers HTTP 403 to the machine that was used. For both files the
// Archive holds several snapshots, from 2021 to 2023, with identical content. If UNECE ever
// replaces a file, the build stops with the checksum it found; check the change, then update the
// value here (or pass the new checksum to the command).
export const DIRECTORIES: readonly DirectoryPin[] = [
  {
    id: "D96A",
    version: "D",
    release: "96A",
    syntaxVersions: [3],
    fileName: "d96a.zip",
    url: "https://unece.org/DAM/trade/untdid/d96a/d96a.zip",
    sha256: "1f94c7663a48bbc99d48e93bab16ed2ee127fda73682e6f4c80363256cbcdcd2",
    parts: {
      elements: "TRED",
      composites: "TRCD",
      segments: "TRSD",
      messages: "TRMD",
      codes: "UNCL",
    },
    codeNameColumn: 10,
  },
  {
    id: "D01B",
    version: "D",
    release: "01B",
    syntaxVersions: [3, 4],
    fileName: "d01b.zip",
    url: "https://unece.org/DAM/trade/untdid/d01b/d01b.zip",
    sha256: "53a44f88b8c54793a07281f220bc30dae6a63deec83348587edbf630c14fac85",
    parts: {
      elements: "EDED",
      composites: "EDCD",
      segments: "EDSD",
      messages: "EDMD",
      codes: "UNCL",
    },
    codeNameColumn: 11,
  },
];

export function findDirectory(id: string): DirectoryPin {
  const pin = DIRECTORIES.find((candidate) => candidate.id === id.toUpperCase());
  if (!pin) {
    const known = DIRECTORIES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown directory "${id}". Supported directories: ${known}.`);
  }
  return pin;
}
