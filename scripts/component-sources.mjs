import { ADAPTERS } from "./adapter-registry.mjs";

const MODEL_SOURCES = Object.freeze({
  "deepseek-v4-flash": "https://api-docs.deepseek.com/",
  "deepseek-v4.1-flash": "https://api-docs.deepseek.com/",
  "glm-5.3-flash": "https://docs.z.ai/guides/overview/models",
  "gpt-5.6-luna": "https://developers.openai.com/api/docs/models",
  "mimo-v2.5": "https://platform.xiaomimimo.com/",
});

function packagePage(name) {
  return `https://www.npmjs.com/package/${name}`;
}

/** Public source links for harnesses and models; unknown components remain ordinary text. */
export function componentSources(observedHarnesses = []) {
  const harnesses = Object.fromEntries(
    Object.entries(ADAPTERS).map(([id, adapter]) => {
      const packageName = adapter.extensionPackage ?? adapter.package;
      return [
        id,
        {
          repositoryUrl: adapter.repositoryUrl,
          packageName,
          packageUrl: packagePage(packageName),
        },
      ];
    }),
  );
  for (const id of observedHarnesses)
    if (!(id in harnesses)) harnesses[id] = { packageName: id, packageUrl: packagePage(id) };
  return {
    harnesses,
    models: Object.fromEntries(
      Object.entries(MODEL_SOURCES).map(([id, officialPageUrl]) => [id, { officialPageUrl }]),
    ),
  };
}
