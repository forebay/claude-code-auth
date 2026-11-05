import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openForebayLibrary } from "@forebay/host";
import type { AccountsService, ForebayLibrary, ForebayLibrarySource } from "@forebay/host";

const CHECKOUT = join(import.meta.dirname, "..", "siblings", "library");

/**
 * @implNote The CMake of `forebay/library` sets only the runtime output folder, so the Windows DLL
 * lands in `build/bin/Release` while a shared object or dylib stays in `build` itself.
 */
function builtLibrary(): ForebayLibrarySource {
  const built = join(CHECKOUT, "build");
  return {
    declarationPath: join(CHECKOUT, "library.json"),
    binaryDirectory: process.platform === "win32" ? join(built, "bin", "Release") : built,
    contractsDirectory: join(CHECKOUT, "contracts"),
  };
}

/** The real `accounts` service of the built `forebay/library`, with a store path in a temp folder. */
export interface TestAccounts {
  accounts: AccountsService;
  base: string;
  store: string;
  contractsDirectory: string;
  close(): void;
}

export function openTestAccounts(): TestAccounts {
  const base = mkdtempSync(join(tmpdir(), "claude-code-auth-"));
  const library: ForebayLibrary = openForebayLibrary(builtLibrary(), () => ({ environment: {}, home: join(base, "home"), arguments: [] }));
  return {
    accounts: library.accounts,
    base,
    store: join(base, "accounts.json"),
    contractsDirectory: library.contractsDirectory,
    close: () => {
      library.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
