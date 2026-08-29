import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  // NODE_ENV describes the T3 server process. Inheriting it silently changes
  // application builds and tests launched by an agent. A provider can still
  // opt in through its explicit environment settings.
  delete next.NODE_ENV;
  for (const variable of environment ?? []) {
    next[variable.name] = variable.value;
  }
  return next;
}
