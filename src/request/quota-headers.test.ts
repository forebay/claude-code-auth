import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestAccounts } from "../../test/accounts-library.js";
import type { TestAccounts } from "../../test/accounts-library.js";
import { loadVectors } from "../../test/vectors.js";
import { poolLabel, quotaBars, readPools, remainingFractions } from "./quota-headers.js";
import type { StoredQuota } from "./quota-headers.js";

let library: TestAccounts;

beforeEach(() => {
  library = openTestAccounts();
});

afterEach(() => {
  library.close();
});

interface AccountInput {
  cachedQuota?: StoredQuota;
}

describe("readPools against the Java vectors", () => {
  for (const vector of loadVectors<Record<string, string>, unknown>("quota", "readPools")) {
    it(vector.name, () => {
      expect(readPools(vector.input)).toEqual(vector.expected);
    });
  }
});

describe("poolLabel against the Java vectors", () => {
  for (const vector of loadVectors<string, string>("quota", "poolLabel")) {
    it(vector.name, () => {
      expect(poolLabel(vector.input)).toBe(vector.expected);
    });
  }
});

describe("quotaBars against the Java vectors", () => {
  for (const vector of loadVectors<AccountInput, unknown>("quota", "claudeQuota")) {
    it(vector.name, () => {
      expect(quotaBars(vector.input.cachedQuota) ?? null).toEqual(vector.expected);
    });
  }
});

describe("whether an account has quota left, against the Java vectors and the real accounts service", () => {
  for (const vector of loadVectors<AccountInput, boolean>("quota", "accountHasQuota")) {
    it(vector.name, () => {
      const pools = remainingFractions(vector.input.cachedQuota);
      expect(library.accounts.hasCapacity({ pools }).capacity).toBe(vector.expected);
    });
  }
});
