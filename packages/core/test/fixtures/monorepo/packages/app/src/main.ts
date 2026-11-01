import { add } from "@demo/lib";
import { add as addDirect } from "@demo/lib/math";
import { readFileSync } from "node:fs";

export function run(): number {
  readFileSync("x");
  return add(1, 2) + addDirect(3, 4);
}
