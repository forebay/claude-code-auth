import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One case captured from the Java implementation: what it was given and what it answered. */
export interface Vector<Input = any, Expected = any> {
  name: string;
  fn: string;
  input: Input;
  expected: Expected;
}

const ROOT = join(import.meta.dirname, "vectors");

/** The vectors of a group (a folder of `test/vectors`) that were captured for `functions`, in file name order. */
export function loadVectors<Input = any, Expected = any>(group: string, ...functions: string[]): Vector<Input, Expected>[] {
  return readdirSync(join(ROOT, group))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(ROOT, group, file), "utf8")) as Vector<Input, Expected>)
    .filter((vector) => functions.length === 0 || functions.includes(vector.fn));
}
