/**
 * Run Command - Execute test scenarios
 *
 * Loads configuration, initializes components, runs scenarios,
 * and reports results.
 */

import { join, basename } from 'node:path';
import type { Command } from 'commander';
import { ConfigLoader, type ProbeConfig, type CliOptions } from '../../config/index.js';
import { ScenarioLoader } from '../../scenarios/index.js';
import { SessionLogger, type ScenarioResult } from '../../logging/index.js';
import { BrowserManager } from '../../browser/BrowserManager.js';
import { Observer } from '../../agent/Observer.js';
import { Executor } from '../../agent/Executor.js';
import { Validator } from '../../agent/Validator.js';
import { ClaudeClient } from '../../ai/ClaudeClient.js';
import type { Scenario, ScenarioStep, AgentConfig } from '../../agent/types.js';

/**
 * Step execution result
 */
interface StepResult {
  step: ScenarioStep;
  passed: boolean;
  duration: number;
  error?: string;
}

/**
 * Run command options
 */
interface RunOptions extends CliOptions {
  config: string;
  headless?: boolean;
  headed?: boolean;
  tag?: string[];
  bail?: boolean;
  report?: boolean;
  noIssues?: boolean;
}

/**
 * Format duration in seconds
 */
function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Print the Probe header
 */
function printHeader(): void {
  console.log('\nProbe v0.1.0\n');
}

/**
 * Print scenario loading info
 */
function printLoadingScenarios(scenarios: Scenario[]): void {
  console.log('Loading scenarios...');
  for (const scenario of scenarios) {
    const stepCount = scenario.steps.length;
    console.log(`  - ${scenario.name} (${stepCount} steps)`);
  }
  console.log();
}

/**
 * Print step result
 */
function printStepResult(result: StepResult): void {
  const icon = result.passed ? '\u2713' : '\u2717';
  const duration = formatDuration(result.duration);
  const errorMsg = result.error ? ` - ${result.error}` : '';
  console.log(`  ${icon} ${result.step.name} (${duration})${errorMsg}`);
}

/**
 * Print scenario results summary
 */
function printResultsSummary(
  results: StepResult[],
  totalDuration: number,
  reportPath?: string
): void {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const percentage = total > 0 ? Math.round((passed / total) * 100) : 0;

  console.log();
  console.log(`Results: ${passed}/${total} passed (${percentage}%)`);
  console.log(`Duration: ${formatDuration(totalDuration)}`);

  if (reportPath) {
    console.log(`Report: ${reportPath}`);
  }
  console.log();
}

/**
 * Execute a single scenario
 */
async function executeScenario(
  scenario: Scenario,
  config: ProbeConfig,
  browser: BrowserManager,
  observer: Observer,
  executor: Executor,
  validator: Validator,
  claude: ClaudeClient,
  logger: SessionLogger,
  options: RunOptions
): Promise<{ results: StepResult[]; totalDuration: number }> {
  const results: StepResult[] = [];
  const startTime = Date.now();

  console.log(`Running: ${scenario.name}`);

  // Navigate to base URL if first step has startUrl, or use config baseUrl
  const firstStep = scenario.steps[0];
  const startUrl = firstStep?.startUrl
    ? new URL(firstStep.startUrl, config.app.baseUrl).href
    : config.app.baseUrl;

  await browser.navigate(startUrl);

  for (const step of scenario.steps) {
    const stepStartTime = Date.now();
    await logger.startStep(step);

    let stepPassed = false;
    let stepError: string | undefined;

    try {
      // Navigate to step URL if specified
      if (step.startUrl) {
        const stepUrl = new URL(step.startUrl, config.app.baseUrl).href;
        await browser.navigate(stepUrl);
      }

      // Wait for page to stabilize
      await observer.waitForStable();

      // Observe current state
      const beforeObservation = await observer.observe({ includeScreenshot: true });
      await logger.logObservation(beforeObservation);

      // Get action plan from Claude
      const plan = await claude.planActions({
        goal: step.goal,
        observation: beforeObservation,
        previousActions: logger.getRecentActions(),
      });
      await logger.logPlan(plan);

      // Execute planned actions
      for (const action of plan.actions) {
        const result = await executor.execute(action, beforeObservation);
        await logger.logAction(result);

        if (!result.success) {
          throw new Error(result.error || 'Action execution failed');
        }
      }

      // Wait for changes to settle
      await observer.waitForStable();

      // Observe after state
      const afterObservation = await observer.observe({ includeScreenshot: true });

      // Validate the step
      const validation = await validator.validate({
        step,
        beforeObservation,
        afterObservation,
        expectedOutcome: plan.expectedOutcome,
        assertions: step.assertions,
      });

      if (!validation.passed) {
        throw new Error(validation.reason);
      }

      stepPassed = true;
      await logger.logSuccess(step, 1);
    } catch (error) {
      stepError = error instanceof Error ? error.message : String(error);
      await logger.logError(error instanceof Error ? error : new Error(stepError));
    }

    const stepDuration = Date.now() - stepStartTime;
    const result: StepResult = {
      step,
      passed: stepPassed,
      duration: stepDuration,
      error: stepError,
    };

    results.push(result);
    printStepResult(result);

    // Bail early if requested and step failed
    if (options.bail && !stepPassed) {
      break;
    }
  }

  const totalDuration = Date.now() - startTime;
  return { results, totalDuration };
}

/**
 * Run command handler
 */
export async function runCommand(
  scenarioPaths: string[],
  options: RunOptions
): Promise<void> {
  printHeader();

  // Load configuration
  const configLoader = new ConfigLoader(options.config);
  const config = await configLoader.loadWithOptions(options);

  // Validate environment
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  // Initialize components
  const scenariosDir = join(process.cwd(), 'scenarios');
  const scenarioLoader = new ScenarioLoader(scenariosDir);
  const logger = new SessionLogger(config.logging.directory);

  // Load scenarios
  let scenarios: Scenario[];
  try {
    if (scenarioPaths.length > 0) {
      // Load specific scenarios
      scenarios = [];
      for (const path of scenarioPaths) {
        const scenario = await scenarioLoader.load(path);
        scenarios.push(scenario);
      }
    } else if (options.tag && options.tag.length > 0) {
      // Load by tags
      scenarios = await scenarioLoader.loadByTags(options.tag);
    } else {
      // Load all scenarios
      scenarios = await scenarioLoader.loadAll();
    }
  } catch (error) {
    console.error('Error loading scenarios:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (scenarios.length === 0) {
    console.log('No scenarios found to run.');
    process.exit(0);
  }

  printLoadingScenarios(scenarios);

  // Initialize browser with persistent profile for auth
  const browser = new BrowserManager({
    headless: config.browser.headless,
    timeout: config.browser.timeout,
    slowMo: config.browser.slowMo,
    userDataDir: join(process.cwd(), 'auth', 'browser-profile'),
  });

  // Initialize AI client
  const claude = new ClaudeClient({
    apiKey,
    model: config.model.model,
    maxTokens: config.model.maxTokens,
  });

  let allResults: StepResult[] = [];
  let totalDuration = 0;
  let reportPath: string | undefined;

  try {
    // Start session
    await logger.startSession();

    // Launch browser
    await browser.launch();

    // Initialize observer, executor, validator
    const observer = new Observer(browser);
    const executor = new Executor(browser);
    const validator = new Validator(claude);

    observer.initializeListeners();

    // Run each scenario
    for (const scenario of scenarios) {
      observer.clearErrors();

      const { results, totalDuration: scenarioDuration } = await executeScenario(
        scenario,
        config,
        browser,
        observer,
        executor,
        validator,
        claude,
        logger,
        options
      );

      allResults = allResults.concat(results);
      totalDuration += scenarioDuration;

      // End session for this scenario
      const passed = results.filter((r) => r.passed).length;
      const failed = results.filter((r) => !r.passed).length;

      const scenarioResult: ScenarioResult = {
        scenarioName: scenario.name,
        success: failed === 0,
        totalSteps: results.length,
        completedSteps: passed,
        failedSteps: failed,
        duration: scenarioDuration,
        bugs: [],
        errors: results.filter((r) => r.error).map((r) => r.error!),
      };

      await logger.endSession(scenarioResult);

      // Generate report if requested
      if (options.report) {
        reportPath = await logger.generateReport();
      }

      // Bail if any scenario had failures and bail is set
      if (options.bail && failed > 0) {
        break;
      }
    }
  } catch (error) {
    console.error('Error during execution:', error instanceof Error ? error.message : error);
  } finally {
    await browser.close();
  }

  printResultsSummary(allResults, totalDuration, reportPath);

  // Exit with appropriate code
  const failures = allResults.filter((r) => !r.passed).length;
  process.exit(failures > 0 ? 1 : 0);
}

/**
 * Register run command with Commander program
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run [scenarios...]')
    .description('Run test scenarios')
    .option('-c, --config <path>', 'Config file path', 'probe.config.yaml')
    .option('--headless', 'Run in headless mode')
    .option('--headed', 'Run in headed mode (default)')
    .option('--tag <tags...>', 'Filter by tags')
    .option('--bail', 'Stop on first failure')
    .option('--report', 'Generate HTML report')
    .option('--no-issues', "Don't create GitHub issues")
    .action(async (scenarios: string[], options: RunOptions) => {
      await runCommand(scenarios, options);
    });
}
