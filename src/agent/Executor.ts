/**
 * Executor - Translates AI action plans into Playwright commands
 *
 * Takes PlannedAction objects and executes them via Playwright,
 * returning ExecutedAction with success/failure status.
 */

import type { Page, Locator } from 'playwright';
import type { BrowserManager } from '../browser/BrowserManager.js';
import type {
  PlannedAction,
  ExecutedAction,
  PageObservation,
  WaitCondition,
  InteractiveElement,
} from './types.js';

const DEFAULT_WAIT_TIMEOUT = 5000;

/**
 * Parse a Playwright locator string and return a Locator object
 * Handles: getByRole, getByText, getByPlaceholder, getByLabel, locator
 */
function parseLocatorString(page: Page, locatorStr: string): Locator | null {
  // getByRole('button', { name: 'Submit' })
  const roleMatch = locatorStr.match(/^getByRole\('([^']+)'(?:,\s*\{\s*name:\s*'([^']+)'\s*\})?\)$/);
  if (roleMatch) {
    const [, role, name] = roleMatch;
    return name ? page.getByRole(role as any, { name }) : page.getByRole(role as any);
  }

  // getByText('Some text')
  const textMatch = locatorStr.match(/^getByText\('([^']+)'\)$/);
  if (textMatch) {
    return page.getByText(textMatch[1]);
  }

  // getByPlaceholder('Email')
  const placeholderMatch = locatorStr.match(/^getByPlaceholder\('([^']+)'\)$/);
  if (placeholderMatch) {
    return page.getByPlaceholder(placeholderMatch[1]);
  }

  // getByLabel('Email')
  const labelMatch = locatorStr.match(/^getByLabel\('([^']+)'\)$/);
  if (labelMatch) {
    return page.getByLabel(labelMatch[1]);
  }

  // locator('css-selector')
  const locatorMatch = locatorStr.match(/^locator\('(.+)'\)$/);
  if (locatorMatch) {
    return page.locator(locatorMatch[1]);
  }

  return null;
}

export class Executor {
  private page: Page;

  constructor(private browser: BrowserManager) {
    this.page = browser.page;
  }

  /**
   * Execute a planned action and return the result
   */
  async execute(
    action: PlannedAction,
    observation: PageObservation
  ): Promise<ExecutedAction> {
    const startTime = Date.now();
    let success = false;
    let error: string | undefined;
    let screenshot: string | undefined;

    try {
      // Resolve the target to an actual selector
      const selector = this.resolveSelector(action.target, observation);

      // Execute the action based on type
      await this.executeAction(action, selector);

      // Handle wait condition if specified
      if (action.waitAfter) {
        await this.waitFor(action.waitAfter);
      }

      success = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // Take screenshot on failure
      try {
        screenshot = await this.browser.screenshotBase64();
      } catch {
        // Ignore screenshot errors
      }
    }

    const duration = Date.now() - startTime;

    return {
      plan: action,
      success,
      duration,
      error,
      screenshot,
    };
  }

  /**
   * Wait for a specific condition
   */
  async waitFor(condition: WaitCondition): Promise<void> {
    const timeout = condition.timeout ?? DEFAULT_WAIT_TIMEOUT;

    switch (condition.type) {
      case 'url':
        await this.page.waitForURL(condition.value, { timeout });
        break;

      case 'element':
        await this.page.waitForSelector(condition.value, {
          state: 'visible',
          timeout,
        });
        break;

      case 'network':
        await this.page.waitForLoadState(
          condition.value as 'load' | 'domcontentloaded' | 'networkidle',
          { timeout }
        );
        break;

      case 'time':
        await this.page.waitForTimeout(parseInt(condition.value, 10));
        break;

      case 'text':
        await this.page.waitForFunction(
          (text: string) => document.body.innerText.includes(text),
          condition.value,
          { timeout }
        );
        break;

      default:
        throw new Error(`Unknown wait condition type: ${condition.type}`);
    }
  }

  /**
   * Get a Playwright Locator from a selector string
   * Handles both CSS selectors and Playwright locator method strings
   */
  private getLocator(selector: string): Locator {
    // Try parsing as a Playwright locator method string
    const parsed = parseLocatorString(this.page, selector);
    if (parsed) {
      return parsed;
    }
    // Fall back to CSS selector
    return this.page.locator(selector);
  }

  /**
   * Execute the specific action type
   */
  private async executeAction(
    action: PlannedAction,
    selector: string
  ): Promise<void> {
    const locator = this.getLocator(selector);

    switch (action.type) {
      case 'click':
        await locator.click();
        break;

      case 'fill':
        if (action.value === undefined) {
          throw new Error('Fill action requires a value');
        }
        // Clear existing content before filling
        await locator.fill(action.value);
        break;

      case 'select':
        if (action.value === undefined) {
          throw new Error('Select action requires a value');
        }
        await locator.selectOption(action.value);
        break;

      case 'check':
        await locator.check();
        break;

      case 'uncheck':
        await locator.uncheck();
        break;

      case 'hover':
        await locator.hover();
        break;

      case 'press':
        if (action.value === undefined) {
          throw new Error('Press action requires a key value');
        }
        // If selector provided, focus element first
        if (selector && selector !== '__keyboard__') {
          await locator.click();
        }
        await this.page.keyboard.press(action.value);
        break;

      case 'scroll':
        await this.handleScroll(action, selector);
        break;

      case 'wait':
        // Wait action uses waitAfter condition
        if (action.waitAfter) {
          await this.waitFor(action.waitAfter);
        } else if (action.value) {
          // Default to time wait if value is provided
          await this.page.waitForTimeout(parseInt(action.value, 10));
        }
        break;

      case 'navigate':
        if (action.value === undefined) {
          throw new Error('Navigate action requires a URL value');
        }
        await this.browser.navigate(action.value);
        break;

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  /**
   * Handle scroll action
   */
  private async handleScroll(
    action: PlannedAction,
    selector: string
  ): Promise<void> {
    if (selector && selector !== '__page__') {
      // Scroll element into view
      await this.page.locator(selector).scrollIntoViewIfNeeded();
    } else if (action.value) {
      // Scroll page by amount (format: "x,y" or just "y")
      const parts = action.value.split(',').map((p) => parseInt(p.trim(), 10));
      const deltaX = parts.length > 1 ? parts[0] : 0;
      const deltaY = parts.length > 1 ? parts[1] : parts[0];
      await this.page.mouse.wheel(deltaX, deltaY);
    }
  }

  /**
   * Resolve action target to a Playwright selector
   *
   * The target can be:
   * - An element ID from the observation (e.g., "el-5")
   * - A CSS selector
   * - A Playwright locator string
   * - A special value like "__keyboard__" or "__page__"
   */
  private resolveSelector(
    target: string,
    observation: PageObservation
  ): string {
    // Handle special targets
    if (target === '__keyboard__' || target === '__page__') {
      return target;
    }

    // Check if target matches an element ID from observation
    const element = this.findElementById(target, observation);
    if (element) {
      // Prefer playwrightLocator if available, otherwise use CSS selector
      return element.playwrightLocator || element.selector;
    }

    // Try to find element by text match
    const elementByText = this.findElementByText(target, observation);
    if (elementByText) {
      return elementByText.playwrightLocator || elementByText.selector;
    }

    // Assume target is already a valid selector
    return target;
  }

  /**
   * Find element in observation by its ID
   */
  private findElementById(
    id: string,
    observation: PageObservation
  ): InteractiveElement | undefined {
    // Direct ID match
    const element = observation.interactiveElements.find((el) => el.id === id);
    if (element) return element;

    // Also check form fields
    for (const form of observation.forms) {
      for (const field of form.fields) {
        if (field.element.id === id) {
          return field.element;
        }
      }
      if (form.submitButton?.id === id) {
        return form.submitButton;
      }
    }

    return undefined;
  }

  /**
   * Find element in observation by text content
   */
  private findElementByText(
    text: string,
    observation: PageObservation
  ): InteractiveElement | undefined {
    const normalizedText = text.toLowerCase().trim();

    // Search through interactive elements
    for (const el of observation.interactiveElements) {
      if (
        el.text.toLowerCase().includes(normalizedText) ||
        el.ariaLabel?.toLowerCase().includes(normalizedText) ||
        el.placeholder?.toLowerCase().includes(normalizedText)
      ) {
        return el;
      }
    }

    // Search through form fields
    for (const form of observation.forms) {
      for (const field of form.fields) {
        if (
          field.label?.toLowerCase().includes(normalizedText) ||
          field.element.text.toLowerCase().includes(normalizedText)
        ) {
          return field.element;
        }
      }
    }

    return undefined;
  }
}
