/**
 * SelfHealer - Recovery strategies for failed actions
 *
 * Implements progressive recovery strategies to recover from failed actions:
 * 1. wait_and_retry - Wait for loading, network idle, then retry
 * 2. refresh_and_retry - Reload page and retry
 * 3. alternative_selector - Ask Claude for alternative element
 * 4. screenshot_analysis - Send screenshot to Claude for diagnosis
 * 5. reset_to_known_state - Navigate to known URL and restart step
 */

import type { BrowserManager } from '../browser/BrowserManager.js';
import type { ClaudeClient } from '../ai/ClaudeClient.js';
import type { Observer } from './Observer.js';
import type {
  HealingStrategy,
  PageObservation,
  ActionPlan,
  PlannedAction,
} from './types.js';

/**
 * Context for a recovery attempt
 */
export interface RecoveryContext {
  error: Error;
  observation: PageObservation;
  plan: ActionPlan;
  strategy: HealingStrategy;
  failedAction?: PlannedAction;
  baseUrl?: string;
  stepStartUrl?: string;
}

/**
 * Result of a recovery attempt
 */
export interface RecoveryResult {
  success: boolean;
  updatedPlan?: ActionPlan;
  newObservation?: PageObservation;
  message: string;
}

/**
 * Configuration for healing delays (in ms)
 */
const HEALING_DELAYS = {
  wait_and_retry: {
    networkIdle: 2000,
    loadingCheck: 500,
    animationBuffer: 500,
  },
  refresh_and_retry: {
    afterReload: 1000,
    stabilization: 500,
  },
  alternative_selector: {
    beforeAnalysis: 500,
  },
  screenshot_analysis: {
    beforeCapture: 500,
  },
  reset_to_known_state: {
    afterNavigation: 2000,
    modalDismiss: 300,
  },
};

/**
 * Loading indicator selectors to check during wait_and_retry
 */
const LOADING_SELECTORS = [
  '[data-loading="true"]',
  '[aria-busy="true"]',
  '.loading',
  '.spinner',
  '.skeleton',
  '[class*="loading"]',
  '[class*="spinner"]',
];

/**
 * SelfHealer class - Attempts recovery from failed actions
 */
export class SelfHealer {
  constructor(
    private browser: BrowserManager,
    private observer: Observer,
    private claude: ClaudeClient
  ) {}

  /**
   * Attempt recovery using the specified strategy
   */
  async attemptRecovery(context: RecoveryContext): Promise<RecoveryResult> {
    const { strategy } = context;

    try {
      switch (strategy) {
        case 'wait_and_retry':
          return await this.waitAndRetry(context);

        case 'refresh_and_retry':
          return await this.refreshAndRetry(context);

        case 'alternative_selector':
          return await this.findAlternativeSelector(context);

        case 'screenshot_analysis':
          return await this.analyzeScreenshot(context);

        case 'reset_to_known_state':
          return await this.resetToKnownState(context);

        default:
          return {
            success: false,
            message: `Unknown healing strategy: ${strategy}`,
          };
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Recovery failed: ${err.message}`,
      };
    }
  }

  /**
   * Strategy: wait_and_retry
   * Wait for network idle, check for loading indicators, wait for animations
   */
  private async waitAndRetry(context: RecoveryContext): Promise<RecoveryResult> {
    // Wait for network to become idle
    try {
      await this.browser.waitForLoadState('networkidle');
    } catch {
      // Timeout is acceptable, continue with other checks
    }

    // Check for loading indicators
    const hasLoadingIndicators = await this.checkLoadingIndicators();
    if (hasLoadingIndicators) {
      // Wait additional time for loading to complete
      await this.browser.waitForTimeout(HEALING_DELAYS.wait_and_retry.loadingCheck);

      // Check again
      const stillLoading = await this.checkLoadingIndicators();
      if (stillLoading) {
        // Wait longer and re-check observation
        await this.browser.waitForTimeout(HEALING_DELAYS.wait_and_retry.networkIdle);
      }
    }

    // Wait for animations to settle
    await this.browser.waitForTimeout(HEALING_DELAYS.wait_and_retry.animationBuffer);

    // Get fresh observation
    const newObservation = await this.observer.observe({ includeScreenshot: true });

    return {
      success: true,
      newObservation,
      message: 'Waited for page to stabilize',
    };
  }

  /**
   * Strategy: refresh_and_retry
   * Reload the page and wait for it to stabilize
   */
  private async refreshAndRetry(context: RecoveryContext): Promise<RecoveryResult> {
    // Reload the page
    await this.browser.reload();

    // Wait for load state
    await this.browser.waitForLoadState('networkidle');

    // Additional stabilization time
    await this.browser.waitForTimeout(HEALING_DELAYS.refresh_and_retry.stabilization);

    // Wait for stable state via observer
    await this.observer.waitForStable();

    // Get fresh observation
    const newObservation = await this.observer.observe({ includeScreenshot: true });

    return {
      success: true,
      newObservation,
      message: 'Page refreshed and stabilized',
    };
  }

  /**
   * Strategy: alternative_selector
   * Ask Claude for an alternative element to achieve the same goal
   */
  private async findAlternativeSelector(
    context: RecoveryContext
  ): Promise<RecoveryResult> {
    const { observation, plan, failedAction } = context;

    // Take a fresh screenshot for analysis
    await this.browser.waitForTimeout(HEALING_DELAYS.alternative_selector.beforeAnalysis);
    const freshObservation = await this.observer.observe({ includeScreenshot: true });

    // Build prompt for Claude to find alternative
    const targetDescription = failedAction
      ? `The action "${failedAction.description}" targeting "${failedAction.target}" failed.`
      : `An action in the plan failed.`;

    const goal = plan.expectedOutcome;
    const alternativeRequest = {
      goal: `${targetDescription} Find an alternative element or approach to achieve: ${goal}`,
      observation: freshObservation,
      previousActions: [`[FAILED] ${failedAction?.description || 'Unknown action'}`],
    };

    // Ask Claude for alternative plan
    const updatedPlan = await this.claude.planActions(alternativeRequest);

    // Check if Claude found an alternative approach
    if (updatedPlan.actions.length === 0) {
      return {
        success: false,
        newObservation: freshObservation,
        message: 'Claude could not find an alternative approach',
      };
    }

    return {
      success: true,
      updatedPlan,
      newObservation: freshObservation,
      message: `Found alternative approach: ${updatedPlan.reasoning}`,
    };
  }

  /**
   * Strategy: screenshot_analysis
   * Send screenshot to Claude for diagnosis and recovery suggestion
   */
  private async analyzeScreenshot(
    context: RecoveryContext
  ): Promise<RecoveryResult> {
    const { error, plan } = context;

    // Wait briefly before capturing
    await this.browser.waitForTimeout(HEALING_DELAYS.screenshot_analysis.beforeCapture);

    // Capture current state with screenshot
    const freshObservation = await this.observer.observe({ includeScreenshot: true });

    // Build diagnosis request for Claude
    const diagnosisGoal = `Analyze this page state after an error occurred.
Error: ${error.message}
Original goal: ${plan.expectedOutcome}

Determine:
1. What is the current page state?
2. Are there any error messages or unexpected elements visible?
3. What action should be taken to recover and continue toward the goal?

Provide a plan to recover from this state.`;

    // Get recovery plan from Claude
    const recoveryPlan = await this.claude.planActions({
      goal: diagnosisGoal,
      observation: freshObservation,
      previousActions: [
        `[ERROR] ${error.message}`,
        `[ORIGINAL GOAL] ${plan.expectedOutcome}`,
      ],
    });

    // Check if recovery actions were suggested
    if (recoveryPlan.actions.length === 0 && recoveryPlan.confidence < 0.5) {
      return {
        success: false,
        newObservation: freshObservation,
        message: 'Screenshot analysis could not determine recovery path',
      };
    }

    return {
      success: true,
      updatedPlan: recoveryPlan,
      newObservation: freshObservation,
      message: `Screenshot analysis: ${recoveryPlan.reasoning}`,
    };
  }

  /**
   * Strategy: reset_to_known_state
   * Navigate to a known URL and restart from there
   */
  private async resetToKnownState(
    context: RecoveryContext
  ): Promise<RecoveryResult> {
    const { stepStartUrl, baseUrl } = context;

    // Determine reset URL (prefer step's startUrl, fallback to baseUrl)
    const resetUrl = stepStartUrl || baseUrl || '/';

    // Navigate to known state
    await this.browser.navigate(resetUrl);

    // Wait for navigation to complete
    await this.browser.waitForLoadState('networkidle');

    // Attempt to clear any modals by pressing Escape
    await this.dismissModals();

    // Wait for stabilization
    await this.browser.waitForTimeout(HEALING_DELAYS.reset_to_known_state.afterNavigation);

    // Wait for stable state
    await this.observer.waitForStable();

    // Get fresh observation
    const newObservation = await this.observer.observe({ includeScreenshot: true });

    return {
      success: true,
      newObservation,
      message: `Reset to known state: ${resetUrl}`,
    };
  }

  /**
   * Check for loading indicators on the page
   */
  private async checkLoadingIndicators(): Promise<boolean> {
    const page = this.browser.page;

    for (const selector of LOADING_SELECTORS) {
      try {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            return true;
          }
        }
      } catch {
        // Selector check failed, continue to next
      }
    }

    return false;
  }

  /**
   * Attempt to dismiss any open modals by pressing Escape
   */
  private async dismissModals(): Promise<void> {
    const page = this.browser.page;

    // Press Escape multiple times to dismiss nested modals
    for (let i = 0; i < 3; i++) {
      try {
        await page.keyboard.press('Escape');
        await this.browser.waitForTimeout(HEALING_DELAYS.reset_to_known_state.modalDismiss);
      } catch {
        // Modal dismissal failed, continue
      }
    }
  }

  /**
   * Select the appropriate healing strategy based on error and attempt number
   */
  static selectStrategy(error: Error, attempt: number): HealingStrategy {
    const errorMessage = error.message.toLowerCase();

    // First attempt: simple wait and retry (transient issues)
    if (attempt === 1) {
      return 'wait_and_retry';
    }

    // Second attempt: check for specific error patterns
    if (attempt === 2) {
      if (
        errorMessage.includes('timeout') ||
        errorMessage.includes('not found') ||
        errorMessage.includes('no element') ||
        errorMessage.includes('locator')
      ) {
        return 'alternative_selector';
      }
      if (
        errorMessage.includes('network') ||
        errorMessage.includes('loading') ||
        errorMessage.includes('hydrat') ||
        errorMessage.includes('navigation')
      ) {
        return 'refresh_and_retry';
      }
      return 'screenshot_analysis';
    }

    // Third attempt: reset to known state
    return 'reset_to_known_state';
  }
}
