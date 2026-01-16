/**
 * Validator - Assertion checking for test step validation
 *
 * Compares before/after page observations and checks scenario assertions
 * to determine if actions achieved their expected outcomes.
 */

import type { ClaudeClient } from '../ai/ClaudeClient.js';
import type {
  ScenarioStep,
  PageObservation,
  Assertion,
  InteractiveElement,
} from './types.js';

export interface ValidationRequest {
  step: ScenarioStep;
  beforeObservation: PageObservation;
  afterObservation: PageObservation;
  expectedOutcome: string;
  assertions?: Assertion[];
}

export interface ValidationResult {
  passed: boolean;
  reason: string;
  failures: string[];
}

interface AssertionResult {
  passed: boolean;
  message: string;
}

export class Validator {
  constructor(private claude: ClaudeClient) {}

  /**
   * Validate a step by checking assertions and using Claude for semantic validation
   */
  async validate(request: ValidationRequest): Promise<ValidationResult> {
    const failures: string[] = [];

    // First, check explicit assertions if provided
    if (request.assertions && request.assertions.length > 0) {
      for (const assertion of request.assertions) {
        const result = this.checkAssertion(assertion, request.afterObservation);
        if (!result.passed) {
          failures.push(result.message);
        }
      }
    }

    // If any assertions failed, return early
    if (failures.length > 0) {
      return {
        passed: false,
        reason: `Assertion checks failed: ${failures.join('; ')}`,
        failures,
      };
    }

    // Use Claude for semantic validation of the expected outcome
    const semanticResult = await this.semanticValidation(request);

    if (!semanticResult.passed) {
      failures.push(semanticResult.reason);
    }

    return {
      passed: semanticResult.passed,
      reason: semanticResult.reason,
      failures,
    };
  }

  /**
   * Check a single assertion against the page observation
   */
  private checkAssertion(
    assertion: Assertion,
    observation: PageObservation
  ): AssertionResult {
    switch (assertion.type) {
      case 'url':
        return this.checkUrlAssertion(assertion, observation);
      case 'element_exists':
        return this.checkElementExistsAssertion(assertion, observation);
      case 'element_text':
        return this.checkElementTextAssertion(assertion, observation);
      case 'element_value':
        return this.checkElementValueAssertion(assertion, observation);
      case 'toast':
        return this.checkToastAssertion(assertion, observation);
      case 'no_errors':
        return this.checkNoErrorsAssertion(observation);
      default:
        return {
          passed: false,
          message: `Unknown assertion type: ${(assertion as Assertion).type}`,
        };
    }
  }

  /**
   * Check URL assertion
   */
  private checkUrlAssertion(
    assertion: Assertion,
    observation: PageObservation
  ): AssertionResult {
    const currentUrl = observation.url;
    const expectedValue = assertion.value || '';
    const operator = assertion.operator || 'contains';

    const passed = this.compareValues(currentUrl, expectedValue, operator);

    return {
      passed,
      message: passed
        ? `URL ${operator} "${expectedValue}"`
        : `URL assertion failed: expected "${currentUrl}" to ${operator} "${expectedValue}"`,
    };
  }

  /**
   * Check element exists assertion
   */
  private checkElementExistsAssertion(
    assertion: Assertion,
    observation: PageObservation
  ): AssertionResult {
    const selector = assertion.target || '';
    const element = this.findElementBySelector(selector, observation);

    const shouldExist = assertion.operator !== 'not_equals';
    const exists = element !== null && element.visible;

    const passed = shouldExist ? exists : !exists;

    return {
      passed,
      message: passed
        ? `Element "${selector}" ${shouldExist ? 'exists' : 'does not exist'}`
        : `Element assertion failed: "${selector}" ${shouldExist ? 'not found or not visible' : 'should not exist but was found'}`,
    };
  }

  /**
   * Check element text assertion
   */
  private checkElementTextAssertion(
    assertion: Assertion,
    observation: PageObservation
  ): AssertionResult {
    const selector = assertion.target || '';
    const expectedValue = assertion.value || '';
    const operator = assertion.operator || 'contains';

    const element = this.findElementBySelector(selector, observation);

    if (!element) {
      return {
        passed: false,
        message: `Element text assertion failed: element "${selector}" not found`,
      };
    }

    const actualText = element.text || '';
    const passed = this.compareValues(actualText, expectedValue, operator);

    return {
      passed,
      message: passed
        ? `Element "${selector}" text ${operator} "${expectedValue}"`
        : `Element text assertion failed: expected text "${actualText}" to ${operator} "${expectedValue}"`,
    };
  }

  /**
   * Check element value assertion (for inputs)
   */
  private checkElementValueAssertion(
    assertion: Assertion,
    observation: PageObservation
  ): AssertionResult {
    const selector = assertion.target || '';
    const expectedValue = assertion.value || '';
    const operator = assertion.operator || 'equals';

    const element = this.findElementBySelector(selector, observation);

    if (!element) {
      return {
        passed: false,
        message: `Element value assertion failed: element "${selector}" not found`,
      };
    }

    const actualValue = element.value || '';
    const passed = this.compareValues(actualValue, expectedValue, operator);

    return {
      passed,
      message: passed
        ? `Element "${selector}" value ${operator} "${expectedValue}"`
        : `Element value assertion failed: expected value "${actualValue}" to ${operator} "${expectedValue}"`,
    };
  }

  /**
   * Check toast assertion
   */
  private checkToastAssertion(
    assertion: Assertion,
    observation: PageObservation
  ): AssertionResult {
    const expectedValue = assertion.value || '';
    const operator = assertion.operator || 'contains';

    // Check if any toast matches
    const matchingToast = observation.toasts.find((toast) =>
      this.compareValues(toast.message, expectedValue, operator)
    );

    const passed = matchingToast !== undefined;

    return {
      passed,
      message: passed
        ? `Toast message ${operator} "${expectedValue}"`
        : `Toast assertion failed: no toast message ${operator} "${expectedValue}". Found toasts: ${
            observation.toasts.length > 0
              ? observation.toasts.map((t) => `"${t.message}"`).join(', ')
              : 'none'
          }`,
    };
  }

  /**
   * Check no errors assertion
   */
  private checkNoErrorsAssertion(observation: PageObservation): AssertionResult {
    const hasConsoleErrors = observation.consoleErrors.length > 0;
    const hasNetworkErrors = observation.networkErrors.length > 0;

    const passed = !hasConsoleErrors && !hasNetworkErrors;

    if (passed) {
      return {
        passed: true,
        message: 'No console or network errors detected',
      };
    }

    const errorDetails: string[] = [];
    if (hasConsoleErrors) {
      errorDetails.push(
        `Console errors: ${observation.consoleErrors.slice(0, 3).join('; ')}${
          observation.consoleErrors.length > 3
            ? ` (+${observation.consoleErrors.length - 3} more)`
            : ''
        }`
      );
    }
    if (hasNetworkErrors) {
      errorDetails.push(
        `Network errors: ${observation.networkErrors
          .slice(0, 3)
          .map((e) => `${e.url}: ${e.status || e.error}`)
          .join('; ')}${
          observation.networkErrors.length > 3
            ? ` (+${observation.networkErrors.length - 3} more)`
            : ''
        }`
      );
    }

    return {
      passed: false,
      message: `Errors detected: ${errorDetails.join('. ')}`,
    };
  }

  /**
   * Compare values using the specified operator
   */
  private compareValues(
    actual: string,
    expected: string,
    operator: string
  ): boolean {
    switch (operator) {
      case 'equals':
        return actual === expected;
      case 'contains':
        return actual.includes(expected);
      case 'matches':
        try {
          const regex = new RegExp(expected);
          return regex.test(actual);
        } catch {
          return false;
        }
      case 'not_equals':
        return actual !== expected;
      default:
        return actual.includes(expected);
    }
  }

  /**
   * Find an element by selector in the observation
   * Supports multiple selector formats:
   * - Element ID: elem_1, elem_2, etc.
   * - CSS selector: .class, #id, [attribute]
   * - Text content match
   */
  private findElementBySelector(
    selector: string,
    observation: PageObservation
  ): InteractiveElement | null {
    // Try to find by element ID (e.g., elem_1)
    const byId = observation.interactiveElements.find(
      (el) => el.id === selector
    );
    if (byId) return byId;

    // Try to find by CSS selector match
    const bySelector = observation.interactiveElements.find(
      (el) => el.selector === selector || el.playwrightLocator.includes(selector)
    );
    if (bySelector) return bySelector;

    // Try to find by text content
    const byText = observation.interactiveElements.find(
      (el) =>
        el.text?.toLowerCase().includes(selector.toLowerCase()) ||
        el.ariaLabel?.toLowerCase().includes(selector.toLowerCase())
    );
    if (byText) return byText;

    // Try to find by role attribute
    const byRole = observation.interactiveElements.find(
      (el) => el.role === selector
    );
    if (byRole) return byRole;

    return null;
  }

  /**
   * Use Claude for semantic validation when assertions alone aren't sufficient
   */
  private async semanticValidation(
    request: ValidationRequest
  ): Promise<{ passed: boolean; reason: string }> {
    return this.claude.validateAction({
      step: {
        name: request.step.name,
        goal: request.step.goal,
      },
      beforeObservation: request.beforeObservation,
      afterObservation: request.afterObservation,
      expectedOutcome: request.expectedOutcome,
    });
  }
}
