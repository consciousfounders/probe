/**
 * DOMExtractor - Extract interactive elements from pages
 *
 * Analyzes the DOM to find buttons, inputs, links, and other
 * interactive elements that the AI agent can interact with.
 */

import type { Page } from 'playwright';
import type { InteractiveElement, FormInfo, FormFieldInfo } from '../agent/types.js';

export class DOMExtractor {
  constructor(private page: Page) {}

  async extractInteractiveElements(): Promise<InteractiveElement[]> {
    return await this.page.evaluate(() => {
      const elements: InteractiveElement[] = [];
      let elementId = 0;

      // Selectors for interactive elements
      const selectors = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="combobox"]',
        '[role="listbox"]',
        '[tabindex]:not([tabindex="-1"])',
        '[contenteditable="true"]',
      ];

      const allElements = document.querySelectorAll(selectors.join(', '));

      for (const el of allElements) {
        const rect = el.getBoundingClientRect();

        // Skip invisible elements
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden') continue;
        if (style.display === 'none') continue;

        const htmlEl = el as HTMLElement;

        elements.push({
          id: `elem_${elementId++}`,
          type: categorizeElement(el),
          selector: generateSelector(el),
          playwrightLocator: generatePlaywrightLocator(el),
          text: getElementText(el),
          placeholder: el.getAttribute('placeholder') || undefined,
          value: getElementValue(el),
          disabled: htmlEl.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
          visible: isInViewport(rect),
          ariaLabel: el.getAttribute('aria-label') || undefined,
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      }

      return elements;

      // Helper functions
      function categorizeElement(el: Element): InteractiveElement['type'] {
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type')?.toLowerCase();
        const role = el.getAttribute('role')?.toLowerCase();

        if (tag === 'button' || role === 'button') return 'button';
        if (tag === 'a') return 'link';
        if (tag === 'select' || role === 'listbox') return 'select';
        if (tag === 'textarea') return 'textarea';
        if (role === 'combobox') return 'combobox';
        if (type === 'checkbox' || role === 'checkbox') return 'checkbox';
        if (type === 'radio' || role === 'radio') return 'radio';
        if (tag === 'input') return 'input';
        return 'button'; // Default for other interactive elements
      }

      function generateSelector(el: Element): string {
        // Prefer data-testid
        if (el.hasAttribute('data-testid')) {
          return `[data-testid="${el.getAttribute('data-testid')}"]`;
        }
        // Use ID if unique and stable
        if (el.id && !el.id.match(/^(:|react|radix)/)) {
          return `#${el.id}`;
        }
        // Use aria-label
        if (el.getAttribute('aria-label')) {
          return `[aria-label="${el.getAttribute('aria-label')}"]`;
        }
        // Fallback to tag + text
        const text = el.textContent?.trim().slice(0, 30);
        if (text && el.tagName === 'BUTTON') {
          return `button:has-text("${text}")`;
        }
        // Path-based selector as last resort
        return generatePathSelector(el);
      }

      function generatePathSelector(el: Element): string {
        const parts: string[] = [];
        let current: Element | null = el;

        while (current && current !== document.body) {
          let selector = current.tagName.toLowerCase();
          if (current.id) {
            selector = `#${current.id}`;
            parts.unshift(selector);
            break;
          }
          const siblings = current.parentElement?.children;
          if (siblings && siblings.length > 1) {
            const index = Array.from(siblings).indexOf(current) + 1;
            selector += `:nth-child(${index})`;
          }
          parts.unshift(selector);
          current = current.parentElement;
        }

        return parts.join(' > ');
      }

      function generatePlaywrightLocator(el: Element): string {
        const role = el.getAttribute('role') || getImplicitRole(el);
        const name = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 50);

        if (role && name) {
          return `getByRole('${role}', { name: '${name}' })`;
        }
        if (el.tagName === 'A' && el.textContent?.trim()) {
          return `getByRole('link', { name: '${el.textContent.trim().slice(0, 50)}' })`;
        }
        if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.getAttribute('placeholder')) {
          return `getByPlaceholder('${el.getAttribute('placeholder')}')`;
        }
        return `locator('${generateSelector(el)}')`;
      }

      function getImplicitRole(el: Element): string {
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type')?.toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a' && el.hasAttribute('href')) return 'link';
        if (tag === 'input' && type === 'checkbox') return 'checkbox';
        if (tag === 'input' && type === 'radio') return 'radio';
        if (tag === 'input') return 'textbox';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        return '';
      }

      function getElementText(el: Element): string {
        return el.textContent?.trim().slice(0, 100) || '';
      }

      function getElementValue(el: Element): string | undefined {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          return el.value;
        }
        return undefined;
      }

      function isInViewport(rect: DOMRect): boolean {
        return (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= window.innerHeight &&
          rect.right <= window.innerWidth
        );
      }
    });
  }

  async extractForms(): Promise<FormInfo[]> {
    return await this.page.evaluate(() => {
      const forms: FormInfo[] = [];

      document.querySelectorAll('form').forEach((form, index) => {
        const fields: FormFieldInfo[] = [];

        form.querySelectorAll('input, select, textarea').forEach((field) => {
          const inputField = field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          if (inputField.type === 'hidden') return;

          const label =
            document.querySelector(`label[for="${inputField.id}"]`)?.textContent ||
            inputField.closest('label')?.textContent ||
            inputField.getAttribute('aria-label') ||
            inputField.getAttribute('placeholder');

          fields.push({
            name: inputField.name || inputField.id,
            type: inputField.type || inputField.tagName.toLowerCase(),
            label: label?.trim(),
            required: inputField.hasAttribute('required'),
            value: inputField.value,
            options:
              inputField instanceof HTMLSelectElement
                ? Array.from(inputField.options).map((o) => o.text)
                : undefined,
            element: {} as any, // Placeholder - would need full element info
          });
        });

        forms.push({
          id: form.id || `form_${index}`,
          action: form.action,
          method: form.method,
          fields: fields,
        });
      });

      return forms;
    });
  }

  async detectToasts(): Promise<{ type: string; message: string }[]> {
    return await this.page.evaluate(() => {
      const toasts: { type: string; message: string }[] = [];

      // Sonner toasts (used by Oblique)
      document.querySelectorAll('[data-sonner-toast]').forEach((toast) => {
        const type = toast.getAttribute('data-type') || 'info';
        const message = toast.textContent?.trim() || '';
        toasts.push({ type, message });
      });

      // Generic toast patterns
      document.querySelectorAll('.toast, [role="alert"], [role="status"]').forEach((toast) => {
        const classes = toast.className;
        let type = 'info';
        if (classes.includes('success') || classes.includes('green')) type = 'success';
        if (classes.includes('error') || classes.includes('red')) type = 'error';
        if (classes.includes('warning') || classes.includes('yellow')) type = 'warning';
        toasts.push({ type, message: toast.textContent?.trim() || '' });
      });

      return toasts;
    });
  }

  async detectLoadingIndicators(): Promise<boolean> {
    return await this.page.evaluate(() => {
      // Common loading patterns
      const selectors = [
        '.loading',
        '[data-loading="true"]',
        '[aria-busy="true"]',
        '.spinner',
        '.animate-spin',
        '[role="progressbar"]',
        '.skeleton',
      ];

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return true;
          }
        }
      }
      return false;
    });
  }

  async detectModals(): Promise<{ title: string; visible: boolean }[]> {
    return await this.page.evaluate(() => {
      const modals: { title: string; visible: boolean }[] = [];

      document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal').forEach((modal) => {
        const style = window.getComputedStyle(modal);
        const visible = style.display !== 'none' && style.visibility !== 'hidden';

        const titleEl = modal.querySelector('[role="heading"], h1, h2, h3, .modal-title');
        const title = titleEl?.textContent?.trim() || 'Untitled Modal';

        modals.push({ title, visible });
      });

      return modals;
    });
  }
}
