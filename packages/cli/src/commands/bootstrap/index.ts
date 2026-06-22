/**
 * Bootstrap command — provider-aware dispatcher.
 *
 * `nebula bootstrap --provider <gcp|aws>` runs the matching provider's bootstrap.
 * Add a provider by implementing {@link BootstrapProvider} and registering it below.
 */
import { gcpProvider } from "./gcp";
import { awsProvider } from "./aws";
import type { BootstrapOptions, BootstrapProvider } from "./types";

export type { BootstrapOptions, BootstrapProvider } from "./types";

const PROVIDERS: Record<string, BootstrapProvider> = {
  [gcpProvider.name]: gcpProvider,
  [awsProvider.name]: awsProvider,
};

export async function bootstrap(options: BootstrapOptions): Promise<void> {
  const name = (options.provider || "gcp").toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(
      `Unsupported --provider '${name}' (expected: ${Object.keys(PROVIDERS).join(" | ")})`,
    );
  }
  await provider.bootstrap(options);
}
