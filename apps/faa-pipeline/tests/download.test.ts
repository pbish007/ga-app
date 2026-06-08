import { describe, it, expect, vi } from "vitest";
import AdmZip from "adm-zip";
import { downloadFaaSnapshot, extractFromZip, HttpError } from "../src/lib/download.js";

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

describe("downloadFaaSnapshot retry (PMB-110 AC5)", () => {
  function goodZip(): Buffer {
    const z = new AdmZip();
    for (const f of ["MASTER", "ACFTREF", "ENGINE", "DEALER", "DEREG"]) {
      z.addFile(`${f}.txt`, Buffer.from("h\nrow\n"));
    }
    return z.toBuffer();
  }

  function okResponse(body: Buffer): Response {
    return new Response(body, { status: 200 });
  }

  it("succeeds on first try with no retry delays", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(goodZip()));
    const r = await downloadFaaSnapshot(
      "https://example/zip",
      fetchImpl as unknown as typeof fetch,
      { sleep },
    );
    expect(r.zipBytes).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on 503 and succeeds on the third attempt", async () => {
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(okResponse(goodZip()));

    const r = await downloadFaaSnapshot(
      "https://example/zip",
      fetchImpl as unknown as typeof fetch,
      { sleep, onRetry, baseDelayMs: 10 },
    );

    expect(r.zipBytes).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("retries on thrown network error", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(okResponse(goodZip()));

    const r = await downloadFaaSnapshot(
      "https://example/zip",
      fetchImpl as unknown as typeof fetch,
      { sleep, baseDelayMs: 5 },
    );
    expect(r.zipBytes).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 404 (permanent)", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(
      downloadFaaSnapshot(
        "https://example/zip",
        fetchImpl as unknown as typeof fetch,
        { sleep, baseDelayMs: 5 },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts on persistent transient failure", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 503 }));

    await expect(
      downloadFaaSnapshot(
        "https://example/zip",
        fetchImpl as unknown as typeof fetch,
        { sleep, baseDelayMs: 5, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
