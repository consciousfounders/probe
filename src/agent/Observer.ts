/**
 * Observer - Page state extraction for Claude analysis
 *
 * Extracts the complete page state including interactive elements,
 * modals, toasts, console errors, and network errors.
 */

import type { Page } from 'playwright';
import type { BrowserManager } from '../browser/BrowserManager.js';
import { DOMExtractor } from '../browser/DOMExtractor.js';
import type {
  PageObservation,
  ToastInfo,
  ModalInfo,
  NetworkError,
} from './types.js';

export interface ObserveOptions {
  includeScreenshot?: boolean;
  captureConsole?: boolean;
  captureNetwork?: boolean;
}

export class Observer {
  private page: Page;
  private extractor: DOMExtractor;
  private consoleErrors: string[] = [];
  private networkErrors: NetworkError[] = [];
  private listenersInitialized = false;

  constructor(private browser: BrowserManager) {
    this.page = browser.page;
    this.extractor = new DOMExtractor(this.page);
  }

  /**
   * Initialize console and network error listeners.
   * Should be called once after page is ready.
   */
  initializeListeners(): void {
    if (this.listenersInitialized) return;

    // Capture console errors
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        this.consoleErrors.push(msg.text());
      }
    });

    // Capture page errors (uncaught exceptions)
    this.page.on('pageerror', (error) => {
      this.consoleErrors.push(`Uncaught: ${error.message}`);
    });

    // Capture network failures
    this.page.on('requestfailed', (request) => {
      this.networkErrors.push({
        url: request.url(),
        method: request.method(),
        error: request.failure()?.errorText,
      });
    });

    // Capture HTTP error responses
    this.page.on('response', (response) => {
      if (response.status() >= 400) {
        this.networkErrors.push({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
        });
      }
    });

    this.listenersInitialized = true;
  }

  /**
   * Clear captured errors (useful between test steps)
   */
  clearErrors(): void {
    this.consoleErrors = [];
    this.networkErrors = [];
  }

  /**
   * Get recent console errors
   */
  getConsoleErrors(): string[] {
    return [...this.consoleErrors];
  }

  /**
   * Get recent network errors
   */
  getNetworkErrors(): NetworkError[] {
    return [...this.networkErrors];
  }

  /**
   * Observe the current page state
   */
  async observe(options: ObserveOptions = {}): Promise<PageObservation> {
    const {
      includeScreenshot = false,
      captureConsole = true,
      captureNetwork = true,
    } = options;

    // Ensure listeners are set up
    if ((captureConsole || captureNetwork) && !this.listenersInitialized) {
      this.initializeListeners();
    }

    // Extract all page information in parallel
    const [
      interactiveElements,
      forms,
      rawToasts,
      rawModals,
      loadingIndicators,
    ] = await Promise.all([
      this.extractor.extractInteractiveElements(),
      this.extractor.extractForms(),
      this.extractor.detectToasts(),
      this.extractor.detectModals(),
      this.extractor.detectLoadingIndicators(),
    ]);

    // Convert toast format to match ToastInfo
    const toasts: ToastInfo[] = rawToasts.map((t) => ({
      type: this.normalizeToastType(t.type),
      message: t.message,
    }));

    // Convert modal format to match ModalInfo
    const modals: ModalInfo[] = rawModals;

    // Capture screenshot if requested
    let screenshot: string | undefined;
    if (includeScreenshot) {
      screenshot = await this.browser.screenshotBase64();
    }

    const observation: PageObservation = {
      url: this.page.url(),
      title: await this.page.title(),
      interactiveElements,
      forms,
      modals,
      toasts,
      loadingIndicators,
      consoleErrors: captureConsole ? this.getConsoleErrors() : [],
      networkErrors: captureNetwork ? this.getNetworkErrors() : [],
      screenshot,
      timestamp: new Date(),
    };

    return observation;
  }

  /**
   * Normalize toast type to match ToastInfo type union
   */
  private normalizeToastType(type: string): ToastInfo['type'] {
    const normalized = type.toLowerCase();
    if (normalized === 'success') return 'success';
    if (normalized === 'error') return 'error';
    if (normalized === 'warning') return 'warning';
    return 'info';
  }

  /**
   * Wait for page to be stable (no loading indicators, network idle)
   */
  async waitForStable(timeout = 5000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const isLoading = await this.extractor.detectLoadingIndicators();
      if (!isLoading) {
        // Additional short wait for any pending renders
        await this.page.waitForTimeout(100);
        return;
      }
      await this.page.waitForTimeout(200);
    }
  }

  /**
   * Check if there are any visible toasts
   */
  async hasToasts(): Promise<boolean> {
    const toasts = await this.extractor.detectToasts();
    return toasts.length > 0;
  }

  /**
   * Check if there are any visible modals
   */
  async hasModals(): Promise<boolean> {
    const modals = await this.extractor.detectModals();
    return modals.some((m) => m.visible);
  }

  /**
   * Check if page has any errors (console or network)
   */
  hasErrors(): boolean {
    return this.consoleErrors.length > 0 || this.networkErrors.length > 0;
  }
}
