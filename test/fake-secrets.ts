import type { PluginSecrets } from "@weivel/typescript";

/** An in-memory secret store, the shape a host with a secret store hands a plugin. */
export function fakeSecrets(): PluginSecrets & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (name) => entries.get(name),
    set: async (name, value) => {
      entries.set(name, value);
    },
    delete: async (name) => {
      entries.delete(name);
    },
  };
}
