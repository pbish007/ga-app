import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { extractFromZip } from "../src/lib/download.js";

function makeZip(entries: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [name, body] of Object.entries(entries)) {
    z.addFile(name, Buffer.from(body));
  }
  return z.toBuffer();
}

describe("extractFromZip", () => {
  it("extracts all 5 FAA files with bytes + sha256", () => {
    const zip = makeZip({
      "MASTER.txt": "n,name\nN12345,foo\n",
      "ACFTREF.txt": "code,model\nABC,Cessna 172\n",
      "ENGINE.txt": "code,mfr\nLY01,Lycoming\n",
      "DEALER.txt": "n,dealer\nN999,Acme\n",
      "DEREG.txt": "n,date\nN1,2024-01-01\n",
    });
    const result = extractFromZip(zip);
    expect(Object.keys(result.files).sort()).toEqual([
      "ACFTREF",
      "DEALER",
      "DEREG",
      "ENGINE",
      "MASTER",
    ]);
    expect(result.files.MASTER.bytes).toBe(Buffer.from("n,name\nN12345,foo\n").length);
    expect(result.files.MASTER.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is tolerant of casing and nested paths", () => {
    const zip = makeZip({
      "subdir/master.TXT": "h\nrow\n",
      "ACFTREF.TXT": "h\nrow\n",
      "ENGINE.txt": "h\nrow\n",
      "DEALER.txt": "h\nrow\n",
      "DEREG.txt": "h\nrow\n",
    });
    const result = extractFromZip(zip);
    expect(result.files.MASTER).toBeDefined();
  });

  it("throws when a required file is missing", () => {
    const zip = makeZip({
      "MASTER.txt": "h\n",
      "ACFTREF.txt": "h\n",
      // ENGINE missing
      "DEALER.txt": "h\n",
      "DEREG.txt": "h\n",
    });
    expect(() => extractFromZip(zip)).toThrow(/missing required files.*ENGINE/);
  });
});
