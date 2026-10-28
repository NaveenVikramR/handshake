import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/index.js";

describe("core", () => {
  it("is wired into the workspace test run", () => {
    expect(CORE_VERSION).toBe("0.0.0");
  });
});
