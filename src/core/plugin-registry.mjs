export class PluginRegistry {
  constructor({ forums = [], providers = [], fallback, catalog = [] } = {}) {
    this.forums = forums;
    this.providers = providers;
    this.fallback = fallback;
    this.catalog = catalog;
  }

  forumFor(url) {
    const adapter = this.forums.find((candidate) => candidate.match(url));
    if (!adapter) throw new Error(`No forum adapter matched ${url}`);
    return adapter;
  }

  providerFor(resource) {
    let adapter = this.providers.find((candidate) => candidate.match(resource));
    if (!adapter && this.fallback?.match(resource)) {
      const hostname = new URL(resource.url).hostname.toLowerCase();
      const reserved = this.catalog.some((manifest) => manifest.hosts.some((host) => {
        const base = host.startsWith('*.') ? host.slice(2) : host;
        return hostname === base || (host.startsWith('*.') && hostname.endsWith(`.${base}`));
      }));
      if (!reserved) adapter = this.fallback;
    }
    if (!adapter) throw new Error(`No provider adapter matched ${resource.url}`);
    return adapter;
  }
}
