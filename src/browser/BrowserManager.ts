/**
 * BrowserManager - Playwright browser lifecycle management
 *
 * Handles browser launching, context creation, and page management.
 * Supports both headed and headless modes.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';

export interface BrowserConfig {
  headless: boolean;
  timeout: number;
  slowMo?: number;
  viewport?: { width: number; height: number };
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private _page: Page | null = null;
  private config: BrowserConfig;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  get page(): Page {
    if (!this._page) {
      throw new Error('Page not initialized. Call launch() first.');
    }
    return this._page;
  }

  async launch(): Promise<Page> {
    this.browser = await chromium.launch({
      headless: this.config.headless,
      slowMo: this.config.slowMo,
    });

    this.context = await this.browser.newContext({
      viewport: this.config.viewport ?? { width: 1280, height: 720 },
    });

    this._page = await this.context.newPage();
    this._page.setDefaultTimeout(this.config.timeout);

    return this._page;
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'networkidle' });
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: 'networkidle' });
  }

  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> {
    await this.page.waitForLoadState(state);
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async waitForSelector(
    selector: string,
    options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }
  ): Promise<void> {
    await this.page.waitForSelector(selector, options);
  }

  async screenshot(path: string): Promise<Buffer> {
    return await this.page.screenshot({ path, fullPage: true });
  }

  async screenshotBase64(): Promise<string> {
    const buffer = await this.page.screenshot({ fullPage: true });
    return buffer.toString('base64');
  }

  async saveSession(path: string): Promise<void> {
    if (!this.context) {
      throw new Error('Context not initialized');
    }
    await this.context.storageState({ path });
  }

  async loadSession(path: string): Promise<void> {
    if (this.context) {
      await this.context.close();
    }
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }
    this.context = await this.browser.newContext({ storageState: path });
    this._page = await this.context.newPage();
    this._page.setDefaultTimeout(this.config.timeout);
  }

  async close(): Promise<void> {
    if (this._page) {
      await this._page.close();
      this._page = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
