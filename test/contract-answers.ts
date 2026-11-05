import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";

const CONTRACTS = join(import.meta.dirname, "..", "siblings", "library", "contracts");
const SCHEMA_FILES = ["ir.schema.json", "provider.schema.json"];
const PROVIDER_ID = "https://forebay.github.io/library/contracts/provider.schema.json";

function loadedAjv(): Ajv {
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const file of SCHEMA_FILES) ajv.addSchema(JSON.parse(readFileSync(join(CONTRACTS, file), "utf8")));
  return ajv;
}

const ajv = loadedAjv();

/** The problems the provider contract finds in `value` as `definition`, empty when it conforms. */
export function contractProblems(definition: "ModelsAnswer" | "HandleIrAnswer", value: unknown): string[] {
  const validate = ajv.getSchema(`${PROVIDER_ID}#/definitions/${definition}`);
  if (validate === undefined) throw new Error(`the provider contract defines no ${definition}`);
  validate(value);
  return (validate.errors ?? []).map((problem) => `${problem.instancePath} ${problem.message}`);
}
