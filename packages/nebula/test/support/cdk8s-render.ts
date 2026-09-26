// Rendering helpers for construct tests: synthesize what a builder adds to a
// fresh chart, and render hand-written manifests as raw ApiObjects, the
// construction style of manifests written as plain objects. Comparing the two
// YAML outputs proves that a construct renders byte-identically to those
// plain objects, key order included.
import { ApiObject, App, Chart, type ApiObjectProps } from "cdk8s";

export interface Rendered {
  /** The documents as cdk8s emits them, in emission order. */
  objects: any[];
  /** The chart's YAML stream, exactly as `cdk8s synth` writes it. */
  yaml: string;
}

/** Synthesize the manifests that `build` adds to a fresh chart. */
export function synthOf(build: (chart: Chart) => void): Rendered {
  const app = new App();
  const chart = new Chart(app, "test");
  build(chart);
  return { objects: chart.toJson(), yaml: app.synthYaml() };
}

/** Synthesize plain manifest objects as raw ApiObjects, in the given order. */
export function rawSynth(objects: readonly object[]): Rendered {
  return synthOf(chart => objects.forEach((object, i) => new ApiObject(chart, `raw-${i}`, structuredClone(object) as ApiObjectProps)));
}

/** `Kind/name` of each rendered document, in emission order. */
export const kindsAndNames = (objects: readonly any[]): string[] => objects.map(o => `${o.kind}/${o.metadata.name}`);
