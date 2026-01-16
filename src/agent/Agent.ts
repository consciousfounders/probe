/**
 * Agent - Main orchestrator for the observe→plan→act→validate loop
 *
 * Manages the agent state machine and coordinates Observer, ClaudeClient (Planner),
 * Executor, and Validator to execute test scenarios with self-healing capabilities.
 */

import type { BrowserManager } from '../browser/BrowserManager.js';
import type { ClaudeClient } from '../ai/ClaudeClient.js';
import type { SessionLogger } from '../logging/SessionLogger.js';
import { Observer, type ObserveOptions } from './Observer.js';
import { Executor } from './Executor.js';
import { Validator, type ValidationResult } from './Validator.js';
import type {
  AgentConfig,
  AgentPhase,
  AgentState,
  AgentError,
  Scenario,
  ScenarioStep,
  PageObservation,
  ActionPlan,
  ExecutedAction,
  DetectedBug,
  HealingStrategy,
} from './types.js';

/**
 * Result of a scenario execution
 */
export interface ScenarioResult {
  success: boolean;
  steps: number;
  passed: number;
  failed: number;
  duration: number;
  bugs: DetectedBug[];
  logs: string;
}

/**
 * Result of a single step execution
 */
interface StepExecutionResult {
  success: boolean;
  attempts: number;
  error?: Error;
  bug?: DetectedBug;
}

/**
 * Maximum healing attempts per step
 */
const MAX_HEALING_ATTEMPTS = 3;

/**
 * Delays for different healing strategies (in ms)
 */
const HEALING_DELAYS: Record<HealingStrategy, number> = {
  wait_and_retry: 2000,
  refresh_and_retry: 1000,
  alternative_selector: 500,
  screenshot_analysis: 1000,
  reset_to_known_state: 2000,
};

/**
 * Agent class - Main orchestrator for test scenario execution
 */
export class Agent {
  private state: AgentState;
  private observer: Observer;
  private executor: Executor;
  private validator: Validator;
  private actionHistory: string[] = [];
  private sessionId: string | null = null;

  constructor(
    private config: AgentConfig,
    private browser: BrowserManager,
    private claude: ClaudeClient,
    private logger: SessionLogger
  ) {
    // Initialize components
    this.observer = new Observer(browser);
    this.executor = new Executor(browser);
    this.validator = new Validator(claude);

    // Initialize state
    this.state = this.createInitialState();
  }

  /**
   * Create the initial agent state
   */
  private createInitialState(): AgentState {
    return {
      phase: 'idle',
      currentScenario: null,
      currentStep: 0,
      pageUrl: '',
      lastObservation: null,
      lastPlan: null,
      lastAction: null,
      errors: [],
      healingAttempts: 0,
    };
  }

  /**
   * Get the current agent state
   */
  getState(): AgentState {
    return { ...this.state };
  }

  /**
   * Get the current phase
   */
  getPhase(): AgentPhase {
    return this.state.phase;
  }

  /**
   * Run a complete scenario
   */
  async runScenario(scenario: Scenario): Promise<ScenarioResult> {
    const startTime = Date.now();
    const bugs: DetectedBug[] = [];
    let passedSteps = 0;
    let failedSteps = 0;

    // Initialize state for this scenario
    this.state = this.createInitialState();
    this.state.currentScenario = scenario;
    this.actionHistory = [];

    // Start logging session
    this.sessionId = await this.logger.startSession();

    // Initialize observer listeners
    this.observer.initializeListeners();

    try {
      // Navigate to base URL if setup requires it
      if (scenario.setup?.preconditions) {
        await this.handleSetup(scenario);
      }

      // Execute each step
      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        this.state.currentStep = i;
        this.state.healingAttempts = 0;

        // Clear observer errors between steps
        this.observer.clearErrors();

        const result = await this.executeStep(step);

        if (result.success) {
          passedSteps++;
          await this.logger.logSuccess(step, result.attempts);
        } else {
          failedSteps++;
          if (result.bug) {
            bugs.push(result.bug);
            await this.logger.logBug(result.bug);
          }

          // Check if we should continue or abort
          const maxAttempts = step.maxAttempts ?? MAX_HEALING_ATTEMPTS;
          if (result.attempts >= maxAttempts) {
            // Record failure and continue to next step
            this.state.errors.push({
              type: 'action_failed',
              message: result.error?.message || 'Step failed after max attempts',
              timestamp: new Date(),
              context: { step: step.name, attempts: result.attempts },
            });
          }
        }
      }

      this.state.phase = failedSteps === 0 ? 'complete' : 'failed';
    } catch (error) {
      this.state.phase = 'failed';
      const agentError: AgentError = {
        type: 'unexpected',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
        context: { scenario: scenario.name },
      };
      this.state.errors.push(agentError);
      await this.logger.logError(error instanceof Error ? error : new Error(String(error)));
    }

    const duration = Date.now() - startTime;

    // Build result
    const result: ScenarioResult = {
      success: failedSteps === 0,
      steps: scenario.steps.length,
      passed: passedSteps,
      failed: failedSteps,
      duration,
      bugs,
      logs: this.sessionId || '',
    };

    // End logging session
    await this.logger.endSession({
      scenarioName: scenario.name,
      success: result.success,
      totalSteps: result.steps,
      completedSteps: result.passed,
      failedSteps: result.failed,
      duration: result.duration,
      bugs: result.bugs,
      errors: this.state.errors.map((e) => e.message),
    });

    return result;
  }

  /**
   * Execute a single scenario step with healing
   */
  private async executeStep(step: ScenarioStep): Promise<StepExecutionResult> {
    const maxAttempts = step.maxAttempts ?? MAX_HEALING_ATTEMPTS;
    let attempt = 0;
    let lastError: Error | undefined;
    let bug: DetectedBug | undefined;

    await this.logger.startStep(step);

    while (attempt < maxAttempts) {
      attempt++;

      try {
        // Navigate to step URL if specified
        if (step.startUrl) {
          const url = new URL(step.startUrl, this.config.baseUrl).href;
          await this.browser.navigate(url);
        }

        // OBSERVE - Extract page state
        this.state.phase = 'observing';
        await this.observer.waitForStable();
        const beforeObservation = await this.observe({ includeScreenshot: true });
        this.state.lastObservation = beforeObservation;
        await this.logger.logObservation(beforeObservation);

        // PLAN - Get actions from Claude
        this.state.phase = 'planning';
        const plan = await this.plan(step.goal, beforeObservation);
        this.state.lastPlan = plan;
        await this.logger.logPlan(plan);

        // EXECUTE - Run Playwright commands
        this.state.phase = 'executing';
        await this.executeActions(plan, beforeObservation);

        // Wait for page changes to settle
        await this.observer.waitForStable();

        // VALIDATE - Check assertions
        this.state.phase = 'validating';
        const afterObservation = await this.observe({ includeScreenshot: true });

        const validation = await this.validate(
          step,
          beforeObservation,
          afterObservation,
          plan.expectedOutcome
        );

        if (validation.passed) {
          this.state.phase = 'idle';
          return { success: true, attempts: attempt };
        }

        // Validation failed - treat as error for healing
        lastError = new Error(validation.reason);
        throw lastError;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await this.logger.logError(lastError);

        // Check if we should attempt healing
        if (attempt < maxAttempts) {
          this.state.phase = 'healing';
          this.state.healingAttempts++;

          const healingSuccess = await this.handleStepFailure(step, lastError, attempt);

          if (!healingSuccess) {
            // Healing couldn't recover, diagnose the issue
            const observation = await this.observe({ includeScreenshot: true });
            bug = await this.diagnoseBug(step, lastError, observation);
          }
        } else {
          // Max attempts reached, diagnose the bug
          const observation = await this.observe({ includeScreenshot: true });
          bug = await this.diagnoseBug(step, lastError, observation);
        }
      }
    }

    this.state.phase = 'failed';
    return { success: false, attempts: attempt, error: lastError, bug };
  }

  /**
   * Observe the current page state
   */
  private async observe(options: ObserveOptions = {}): Promise<PageObservation> {
    const observation = await this.observer.observe(options);
    this.state.pageUrl = observation.url;
    return observation;
  }

  /**
   * Plan actions using Claude
   */
  private async plan(goal: string, observation: PageObservation): Promise<ActionPlan> {
    return this.claude.planActions({
      goal,
      observation,
      previousActions: this.actionHistory.slice(-10), // Last 10 actions
    });
  }

  /**
   * Execute all actions in a plan
   */
  private async executeActions(
    plan: ActionPlan,
    observation: PageObservation
  ): Promise<void> {
    for (const action of plan.actions) {
      const result = await this.executor.execute(action, observation);
      this.state.lastAction = result;
      await this.logger.logAction(result);

      // Record action in history
      const actionDesc = `${action.type} on ${action.target}${action.value ? ` with "${action.value}"` : ''}`;
      this.actionHistory.push(actionDesc);

      if (!result.success) {
        throw new Error(result.error || `Action failed: ${action.description}`);
      }
    }
  }

  /**
   * Validate step completion
   */
  private async validate(
    step: ScenarioStep,
    before: PageObservation,
    after: PageObservation,
    expectedOutcome: string
  ): Promise<ValidationResult> {
    return this.validator.validate({
      step,
      beforeObservation: before,
      afterObservation: after,
      expectedOutcome,
      assertions: step.assertions,
    });
  }

  /**
   * Select appropriate healing strategy based on error and attempt number
   */
  private selectHealingStrategy(error: Error, attempt: number): HealingStrategy {
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
        errorMessage.includes('no element')
      ) {
        return 'alternative_selector';
      }
      if (
        errorMessage.includes('network') ||
        errorMessage.includes('loading') ||
        errorMessage.includes('hydrat')
      ) {
        return 'refresh_and_retry';
      }
      return 'screenshot_analysis';
    }

    // Third attempt: reset to known state
    return 'reset_to_known_state';
  }

  /**
   * Handle step failure with healing strategy
   */
  private async handleStepFailure(
    step: ScenarioStep,
    error: Error,
    attempt: number
  ): Promise<boolean> {
    const strategy = this.selectHealingStrategy(error, attempt);

    try {
      switch (strategy) {
        case 'wait_and_retry':
          // Simply wait longer before retrying
          await this.browser.waitForTimeout(HEALING_DELAYS.wait_and_retry);
          return true;

        case 'refresh_and_retry':
          // Refresh the page and wait for it to stabilize
          await this.browser.reload();
          await this.observer.waitForStable(HEALING_DELAYS.refresh_and_retry);
          return true;

        case 'alternative_selector':
          // Take a new observation - the retry will use fresh selectors
          await this.browser.waitForTimeout(HEALING_DELAYS.alternative_selector);
          return true;

        case 'screenshot_analysis':
          // Take screenshot for analysis - Claude will use it in next plan
          await this.observe({ includeScreenshot: true });
          await this.browser.waitForTimeout(HEALING_DELAYS.screenshot_analysis);
          return true;

        case 'reset_to_known_state':
          // Navigate back to step's start URL or base URL
          const resetUrl = step.startUrl
            ? new URL(step.startUrl, this.config.baseUrl).href
            : this.config.baseUrl;
          await this.browser.navigate(resetUrl);
          await this.observer.waitForStable(HEALING_DELAYS.reset_to_known_state);
          return true;

        default:
          return false;
      }
    } catch {
      // Healing itself failed
      return false;
    }
  }

  /**
   * Diagnose a bug using Claude
   */
  private async diagnoseBug(
    step: ScenarioStep,
    error: Error,
    observation: PageObservation
  ): Promise<DetectedBug> {
    const diagnosis = await this.claude.diagnoseBug({
      step: { name: step.name, goal: step.goal },
      error,
      observation,
      actionHistory: this.actionHistory,
    });

    // Enrich diagnosis with context
    return {
      ...diagnosis,
      url: observation.url,
      screenshots: observation.screenshot ? [observation.screenshot] : [],
      consoleErrors: observation.consoleErrors,
      networkErrors: observation.networkErrors,
      timestamp: new Date(),
      sessionId: this.sessionId || '',
    };
  }

  /**
   * Handle scenario setup (auth, preconditions)
   */
  private async handleSetup(scenario: Scenario): Promise<void> {
    if (!scenario.setup) return;

    // Handle authentication if configured
    if (scenario.setup.auth) {
      // For now, we only support session file loading
      if (scenario.setup.auth.sessionFile) {
        await this.browser.loadSession(scenario.setup.auth.sessionFile);
      }
    }

    // Handle preconditions (logged but not yet executed)
    if (scenario.setup.preconditions) {
      for (const precondition of scenario.setup.preconditions) {
        this.actionHistory.push(`[Precondition] ${precondition}`);
      }
    }
  }
}
