import { describe, expect, it } from "vitest";
import { GET } from "../app/health/route";

describe("/health", () => {
  it("returns ok status and a timestamp", async () => {
    const res = GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("web");
    expect(typeof body.commit).toBe("string");
    expect(typeof body.timestamp).toBe("string");
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });
});
