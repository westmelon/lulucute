class ExampleForumAdapter {
  match(url) {
    try {
      return new URL(url).hostname === 'forum.example.com';
    } catch {
      return false;
    }
  }

  async inspect(page, url, { navigate = true } = {}) {
    if (navigate) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page.evaluate(() => ({
      locked: Boolean(document.querySelector('[data-reply-required]')),
      source: {
        forum: 'Example Forum',
        section: document.querySelector('[data-section]')?.textContent?.trim() || 'unknown',
        threadId: location.pathname.match(/\d+/)?.[0] || 'unknown',
        threadTitle: document.querySelector('h1')?.textContent?.trim() || document.title
      }
    }));
  }

  async reply(page, message) {
    const form = page.locator('[data-reply-form]');
    await form.locator('textarea').fill(message);
    await form.locator('button[type="submit"]').click();
    await page.locator('[data-reply-required]').waitFor({ state: 'hidden' });
  }

  async extractResources(page, source) {
    const urls = await page.locator('[data-download-url]').evaluateAll((elements) =>
      elements.map((element) => element.href || element.dataset.downloadUrl).filter(Boolean)
    );
    return urls.map((url) => ({ provider: 'direct', url, source }));
  }
}

export function createAdapter() {
  return new ExampleForumAdapter();
}
