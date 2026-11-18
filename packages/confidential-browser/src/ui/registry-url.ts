export function publicRegistryUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z][a-z0-9-]{1,62}$/.test(url.hostname) ||
      /(?:^|[.])(?:localhost|local|svc|internal|test|invalid|cluster|arpa|onion|example)$/.test(url.hostname)) throw new Error("Choose a public HTTPS registry hostname on port 443, without credentials or fragments");
  return url;
}
