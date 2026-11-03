import { delimiter } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveExe, splitArgs } from "./session-history.ts";

test("splitArgs", () => {
  assert.deepEqual(splitArgs("  all  foo "), ["all", "foo"]);
  assert.deepEqual(splitArgs(""), []);
});

test("resolveExe: env override > PATH > fallback", () => {
  assert.equal(resolveExe({ PI_HISTORY_EXE: "X" }, () => false), "X");
  assert.equal(resolveExe({ PATH: ["/a", "/b"].join(delimiter) }, (p) => p === "/b/pi-history"), "pi-history");
  assert.match(resolveExe({ PATH: "/a" }, () => false), /pi-history\.exe$/);
});
