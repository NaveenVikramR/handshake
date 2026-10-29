import { describe, expect, it } from "vitest";
import { jcs } from "../src/jcs.js";

function fromHex(hex: string): number {
  const buf = Buffer.from(hex, "hex");
  return buf.readDoubleBE(0);
}

describe("jcs — RFC 8785 vectors", () => {
  it("§3.2.2 sample structure", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    );
    expect(jcs(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("§3.2.3 sorts keys by UTF-16 code units", () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
        '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",' +
        '"\\u00f6":"Latin Small Letter O With Diaeresis"}',
    );
    expect(jcs(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",' +
        '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",' +
        '"😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it.each([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ])("Appendix B number %s → %s", (hex, expected) => {
    expect(jcs(fromHex(hex))).toBe(expected);
  });

  it.each([["7fffffffffffffff"], ["7ff0000000000000"]])("rejects NaN/Infinity %s", (hex) => {
    expect(() => jcs(fromHex(hex))).toThrow(TypeError);
  });
});

describe("jcs — determinism", () => {
  it("is independent of key insertion order and nesting", () => {
    const a = { b: [1, { y: 2, x: 1 }], a: "s" };
    const b = { a: "s", b: [1, { x: 1, y: 2 }] };
    expect(jcs(a)).toBe(jcs(b));
    expect(jcs(a)).toBe('{"a":"s","b":[1,{"x":1,"y":2}]}');
  });

  it("changes when any value changes", () => {
    expect(jcs({ totalMinor: 499 })).not.toBe(jcs({ totalMinor: 498 }));
    expect(jcs({ a: [1, 2] })).not.toBe(jcs({ a: [2, 1] }));
  });
});

describe("jcs — fails closed on non-JSON input", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  it.each([
    ["undefined", undefined],
    ["undefined property", { a: undefined }],
    ["bigint", 1n],
    ["function", () => 1],
    ["symbol", Symbol("x")],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["class instance", new (class X {})()],
    ["sparse array", Object.assign(new Array<number>(3), { 0: 1, 2: 3 })],
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate", "a\udc00"],
    ["lone surrogate key", { "\ud800": 1 }],
    ["symbol key", { [Symbol("k")]: 1 }],
    ["circular", circular],
  ])("rejects %s", (_name, value) => {
    expect(() => jcs(value)).toThrow(TypeError);
  });

  it("accepts the same object twice when not circular", () => {
    const shared = { x: 1 };
    expect(jcs({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("accepts null-prototype objects and valid surrogate pairs", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.k = "😀";
    expect(jcs(o)).toBe('{"k":"😀"}');
  });
});
