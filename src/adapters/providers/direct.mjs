export class DirectProviderAdapter {
  match(resource) {
    return !resource.provider || resource.provider === 'direct';
  }

  async resolve(_context, resource) {
    return {
      ...resource,
      directUrl: resource.url,
      filename: resource.filename || null,
      headers: resource.headers || {}
    };
  }
}
