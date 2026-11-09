import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/wake/[service]/route";

const call = (service: string, ip = "203.0.113.1") =>
  GET(new Request(`https://web.test/api/wake/${service}`, { headers: { "x-forwarded-for": ip } }), {
    params: Promise.resolve({ service }),
  });

describe("landing page wake route (/api/wake/:service)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("asks only the named service's /health and says whether it is up", async () => {
    vi.stubEnv("MERCHANT_URL", "https://merchant.test/");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      seen.push(u);
      return new Response('{"ok":true}', { status: 200 });
    });
    expect(await (await call("merchant")).json()).toEqual({ up: true });
    expect(seen).toEqual(["https://merchant.test/health"]);
  });

  it("a failing or unreachable service is reported down, with nothing from upstream", async () => {
    vi.stubEnv("CONSUMER_URL", "https://consumer.test");
    vi.stubGlobal("fetch", async () => new Response("secret page", { status: 502 }));
    expect(await (await call("consumer", "203.0.113.2")).json()).toEqual({ up: false });
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    expect(await (await call("consumer", "203.0.113.2")).json()).toEqual({ up: false });
  });

  it("unknown services are 404 and never fetched", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await call("web")).status).toBe(404);
    expect((await call("..%2Fadmin")).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
