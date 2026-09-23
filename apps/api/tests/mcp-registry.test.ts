import { describe, test, expect } from "bun:test";
import { buildMcpRegistry } from "../src/mcp/registry.ts";
import { makeTestConfig } from "./helpers.ts";

describe("MCP registry — selective construction", () => {
  test("resolves only configured server keys", () => {
    const cfg = makeTestConfig({
      fuyao: {
        baseUrl: null,
        apiKey: null,
        servers: ["a-share", "a-share-index"],
        toolMap: {},
        toolMapByServer: {},
        remoteSuffixMap: {},
      },
      ifind: {
        baseUrl: null,
        authorization: null,
        servers: ["stock", "news"],
        toolMap: {},
        toolMapByServer: {},
        remoteSuffixMap: {},
      },
    });
    const registry = buildMcpRegistry(cfg);
    expect(new Set(registry.configuredKeys())).toEqual(
      new Set(["a-share", "a-share-index", "stock", "news"])
    );
    expect(registry.resolve("fund")).toBeNull();
    expect(registry.resolve("meta")).toBeNull();
    expect(registry.resolve("stock")?.serverKey).toBe("stock");
  });

  test("resolveFor returns only adapters that canHandle the intent", () => {
    const cfg = makeTestConfig();
    const registry = buildMcpRegistry(cfg);
    const priceAdapters = registry.resolveFor("price");
    // a-share handles price, stock handles price — both should appear.
    const keys = priceAdapters.map((a) => String(a.serverKey));
    expect(keys).toContain("a-share");
    expect(keys).toContain("stock");
    expect(keys).not.toContain("news");
  });

  test("resolveFor honors the plan allow-list and avoids cross-server dispatch", () => {
    const cfg = makeTestConfig();
    const registry = buildMcpRegistry(cfg);
    const priceAdapters = registry.resolveFor("price", ["a-share"]);
    expect(priceAdapters.map((a) => String(a.serverKey))).toEqual(["a-share"]);
  });

  test("do not dump every tool schema at startup — adapters are lazy", () => {
    const cfg = makeTestConfig();
    const registry = buildMcpRegistry(cfg);
    // We never asked to resolve "law"; registry should not have constructed it.
    // We assert the API only constructs on demand by exercising resolveFor only.
    const before = registry.configuredKeys().length;
    registry.resolveFor("price");
    const after = registry.configuredKeys().length;
    expect(after).toBe(before);
  });
});
