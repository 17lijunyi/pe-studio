import { readFileSync } from "node:fs";

/**
 * Local clones have no Sites control-plane configuration.
 * @param {string | URL} [file]
 */
export function readHostingConfig(file = new URL("../.openai/hosting.json", import.meta.url)) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { d1: null, r2: null };
    throw error;
  }
  return JSON.parse(source);
}
