/**
 * BugDetector - Classifies test failures as app bugs vs agent bugs
 *
 * Uses heuristics to analyze failures and Claude for uncertain cases.
 * Creates DetectedBug objects with classification and reproduction steps.
 */

import type { ClaudeClient } from '../ai/ClaudeClient.js';
import type { BugReporter } from './BugReporter.js';
import type {
  ScenarioStep,
  PageObservation,
  DetectedBug,
  BugClassification,
  NetworkError,
} from '../agent/types.js';

export interface DiagnosisContext {
  step: ScenarioStep;
  error: Error;
  observation: PageObservation;
  actionHistory: string[];
}

export interface HeuristicResult {
  classification: BugClassification;
  confidence: number;
  indicators: string[];
}

/**
 * Thresholds for heuristic confidence
 */
const CONFIDENCE_THRESHOLD = {
  HIGH: 0.8,
  MEDIUM: 0.5,
  LOW: 0.3,
};

/**
 * BugDetector class - Analyzes and classifies test failures
 */
export class BugDetector {
  constructor(
    private claude: ClaudeClient,
    private reporter: BugReporter
  ) {}

  /**
   * Diagnose a failure and create a DetectedBug object
   */
  async diagnose(context: DiagnosisContext): Promise<DetectedBug> {
    const { step, error, observation, actionHistory } = context;

    // First, try heuristic classification
    const heuristic = this.analyzeWithHeuristics(error, observation);

    let bug: DetectedBug;

    // If heuristics are confident, use them directly
    if (heuristic.confidence >= CONFIDENCE_THRESHOLD.HIGH) {
      bug = this.createBugFromHeuristics(context, heuristic);
    } else {
      // Use Claude for uncertain cases
      bug = await this.claude.diagnoseBug({
        step: { name: step.name, goal: step.goal },
        error,
        observation,
        actionHistory,
      });

      // Merge heuristic indicators into description if they add value
      if (heuristic.indicators.length > 0 && heuristic.confidence >= CONFIDENCE_THRESHOLD.LOW) {
        bug.description = `${bug.description}\n\nHeuristic indicators:\n${heuristic.indicators.map(i => `- ${i}`).join('\n')}`;
      }
    }

    // Enrich bug with context
    return this.enrichBug(bug, context);
  }

  /**
   * Report a bug to the application repository
   */
  async reportToAppRepo(bug: DetectedBug): Promise<string> {
    const issueUrl = await this.reporter.reportAppBug(bug);
    return issueUrl || 'Issue creation disabled or failed';
  }

  /**
   * Report a bug to the Probe (agent) repository
   */
  async reportToProbeRepo(bug: DetectedBug): Promise<string> {
    const issueUrl = await this.reporter.reportAgentBug(bug);
    return issueUrl || 'Issue creation disabled or failed';
  }

  /**
   * Analyze failure with heuristics to determine classification
   */
  private analyzeWithHeuristics(
    error: Error,
    observation: PageObservation
  ): HeuristicResult {
    const indicators: string[] = [];
    let appBugScore = 0;
    let agentBugScore = 0;
    let envIssueScore = 0;

    const errorMessage = error.message.toLowerCase();

    // APP_BUG indicators
    const appBugIndicators = this.detectAppBugIndicators(observation, errorMessage);
    indicators.push(...appBugIndicators.indicators);
    appBugScore += appBugIndicators.score;

    // AGENT_BUG indicators
    const agentBugIndicators = this.detectAgentBugIndicators(observation, errorMessage);
    indicators.push(...agentBugIndicators.indicators);
    agentBugScore += agentBugIndicators.score;

    // ENVIRONMENT_ISSUE indicators
    const envIndicators = this.detectEnvironmentIndicators(observation, errorMessage);
    indicators.push(...envIndicators.indicators);
    envIssueScore += envIndicators.score;

    // Determine classification based on scores
    const totalScore = appBugScore + agentBugScore + envIssueScore;
    if (totalScore === 0) {
      return { classification: 'unknown', confidence: 0, indicators };
    }

    const maxScore = Math.max(appBugScore, agentBugScore, envIssueScore);
    const confidence = maxScore / (totalScore + 1); // Normalize with dampening

    let classification: BugClassification;
    if (maxScore === appBugScore) {
      classification = 'app_bug';
    } else if (maxScore === agentBugScore) {
      classification = 'agent_bug';
    } else if (maxScore === envIssueScore) {
      classification = 'environment_issue';
    } else {
      classification = 'unknown';
    }

    return { classification, confidence, indicators };
  }

  /**
   * Detect indicators of application bugs
   */
  private detectAppBugIndicators(
    observation: PageObservation,
    errorMessage: string
  ): { indicators: string[]; score: number } {
    const indicators: string[] = [];
    let score = 0;

    // HTTP 5xx errors
    const serverErrors = observation.networkErrors.filter(
      (e) => e.status && e.status >= 500 && e.status < 600
    );
    if (serverErrors.length > 0) {
      indicators.push(`Server errors (5xx): ${serverErrors.map(e => `${e.status} on ${e.url}`).join(', ')}`);
      score += 3;
    }

    // React/JavaScript errors in console
    const jsErrors = observation.consoleErrors.filter((e) =>
      this.isJavaScriptError(e)
    );
    if (jsErrors.length > 0) {
      indicators.push(`JavaScript errors: ${jsErrors.length} found`);
      score += 2;
    }

    // Check for React-specific errors
    const reactErrors = observation.consoleErrors.filter((e) =>
      this.isReactError(e)
    );
    if (reactErrors.length > 0) {
      indicators.push(`React errors: ${reactErrors.length} found`);
      score += 2;
    }

    // API returning error responses (4xx excluding 401/403 which might be auth)
    const apiErrors = observation.networkErrors.filter(
      (e) => e.status && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403
    );
    if (apiErrors.length > 0) {
      indicators.push(`API errors (4xx): ${apiErrors.map(e => `${e.status} on ${e.url}`).join(', ')}`);
      score += 2;
    }

    // Error message contains app-related terms
    if (
      errorMessage.includes('undefined is not') ||
      errorMessage.includes('cannot read property') ||
      errorMessage.includes('is not a function') ||
      errorMessage.includes('null reference')
    ) {
      indicators.push('Error suggests runtime JavaScript error');
      score += 2;
    }

    return { indicators, score };
  }

  /**
   * Detect indicators of agent bugs
   */
  private detectAgentBugIndicators(
    observation: PageObservation,
    errorMessage: string
  ): { indicators: string[]; score: number } {
    const indicators: string[] = [];
    let score = 0;

    // Selector not found errors
    if (
      errorMessage.includes('no element') ||
      errorMessage.includes('not found') ||
      errorMessage.includes('unable to find') ||
      errorMessage.includes('could not find')
    ) {
      // Check if elements exist in observation (visible in screenshot but not found)
      if (observation.interactiveElements.length > 0) {
        indicators.push('Element not found but page has interactive elements - possible selector issue');
        score += 2;
      } else {
        // Page might actually be empty/loading
        indicators.push('Element not found - page may be empty or still loading');
        score += 1;
      }
    }

    // Timing issues
    if (
      errorMessage.includes('timeout') ||
      errorMessage.includes('waiting for') ||
      errorMessage.includes('timed out')
    ) {
      // If no loading indicators but timeout, might be agent issue
      if (!observation.loadingIndicators) {
        indicators.push('Timeout without loading indicators - possible timing issue in agent');
        score += 2;
      } else {
        indicators.push('Timeout with loading indicators - app may be slow');
        score += 1;
      }
    }

    // Wrong element interaction
    if (
      errorMessage.includes('not interactable') ||
      errorMessage.includes('obscured') ||
      errorMessage.includes('covered by')
    ) {
      indicators.push('Element not interactable - agent may have selected wrong element or timing issue');
      score += 2;
    }

    // Invalid selector generated
    if (
      errorMessage.includes('invalid selector') ||
      errorMessage.includes('syntax error')
    ) {
      indicators.push('Invalid selector syntax - agent bug in selector generation');
      score += 3;
    }

    // Action too fast (element not ready)
    if (
      errorMessage.includes('not attached') ||
      errorMessage.includes('detached') ||
      errorMessage.includes('stale element')
    ) {
      indicators.push('Element detached - action executed too quickly');
      score += 2;
    }

    return { indicators, score };
  }

  /**
   * Detect indicators of environment issues
   */
  private detectEnvironmentIndicators(
    observation: PageObservation,
    errorMessage: string
  ): { indicators: string[]; score: number } {
    const indicators: string[] = [];
    let score = 0;

    // Network connection errors
    const networkFailures = observation.networkErrors.filter((e) =>
      this.isNetworkConnectionError(e)
    );
    if (networkFailures.length > 0) {
      indicators.push(`Network connection errors: ${networkFailures.length} failures`);
      score += 3;
    }

    // Auth token expired (401/403)
    const authErrors = observation.networkErrors.filter(
      (e) => e.status === 401 || e.status === 403
    );
    if (authErrors.length > 0) {
      indicators.push(`Authentication errors: ${authErrors.length} (401/403 responses)`);
      score += 2;
    }

    // Server unreachable
    if (
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('enotfound') ||
      errorMessage.includes('connection refused') ||
      errorMessage.includes('dns') ||
      errorMessage.includes('unreachable')
    ) {
      indicators.push('Server unreachable or DNS failure');
      score += 3;
    }

    // SSL/TLS errors
    if (
      errorMessage.includes('ssl') ||
      errorMessage.includes('tls') ||
      errorMessage.includes('certificate')
    ) {
      indicators.push('SSL/TLS certificate error');
      score += 2;
    }

    // Browser/Playwright specific errors
    if (
      errorMessage.includes('browser has disconnected') ||
      errorMessage.includes('target closed') ||
      errorMessage.includes('context has been destroyed')
    ) {
      indicators.push('Browser context error - environment issue');
      score += 2;
    }

    return { indicators, score };
  }

  /**
   * Check if console error is a JavaScript error
   */
  private isJavaScriptError(error: string): boolean {
    const jsErrorPatterns = [
      'typeerror',
      'referenceerror',
      'syntaxerror',
      'uncaught',
      'unhandled',
      'exception',
      'error:',
    ];
    const lowerError = error.toLowerCase();
    return jsErrorPatterns.some((pattern) => lowerError.includes(pattern));
  }

  /**
   * Check if console error is a React-specific error
   */
  private isReactError(error: string): boolean {
    const reactErrorPatterns = [
      'react',
      'hydration',
      'warning:',
      'each child in a list',
      'invalid hook call',
      'cannot update',
      'maximum update depth',
    ];
    const lowerError = error.toLowerCase();
    return reactErrorPatterns.some((pattern) => lowerError.includes(pattern));
  }

  /**
   * Check if network error is a connection issue (vs HTTP error)
   */
  private isNetworkConnectionError(error: NetworkError): boolean {
    // Has error text but no status (connection failed before response)
    if (error.error && !error.status) {
      return true;
    }
    // Check error text for network-related issues
    if (error.error) {
      const lowerError = error.error.toLowerCase();
      return (
        lowerError.includes('net::') ||
        lowerError.includes('connection') ||
        lowerError.includes('timeout') ||
        lowerError.includes('aborted')
      );
    }
    return false;
  }

  /**
   * Create a DetectedBug from heuristic analysis
   */
  private createBugFromHeuristics(
    context: DiagnosisContext,
    heuristic: HeuristicResult
  ): DetectedBug {
    const { step, error, observation } = context;

    // Determine severity based on classification and indicators
    const severity = this.determineSeverity(heuristic.classification, heuristic.indicators);

    // Generate title based on classification
    const title = this.generateTitle(heuristic.classification, error, observation);

    // Build description from heuristic analysis
    const description = `Heuristic analysis detected ${heuristic.classification.replace('_', ' ')}.\n\nIndicators:\n${heuristic.indicators.map(i => `- ${i}`).join('\n')}`;

    // Generate reproduction steps from action history
    const reproductionSteps = [
      `Navigate to ${observation.url}`,
      ...context.actionHistory.slice(-5), // Last 5 actions
      `Attempt: ${step.goal}`,
      `Error: ${error.message}`,
    ];

    return {
      classification: heuristic.classification,
      confidence: heuristic.confidence,
      title,
      description,
      severity,
      reproductionSteps,
      expectedBehavior: step.goal,
      actualBehavior: error.message,
      screenshots: [],
      consoleErrors: [],
      networkErrors: [],
      url: '',
      timestamp: new Date(),
      sessionId: '',
    };
  }

  /**
   * Determine bug severity based on classification and indicators
   */
  private determineSeverity(
    classification: BugClassification,
    indicators: string[]
  ): DetectedBug['severity'] {
    // Server errors and critical JS errors are high/critical
    const hasServerError = indicators.some((i) => i.includes('5xx') || i.includes('Server error'));
    const hasJsError = indicators.some((i) => i.includes('JavaScript error') || i.includes('React error'));

    if (classification === 'app_bug') {
      if (hasServerError) return 'critical';
      if (hasJsError) return 'high';
      return 'medium';
    }

    if (classification === 'agent_bug') {
      // Agent bugs are usually medium priority for self-improvement
      if (indicators.some((i) => i.includes('Invalid selector'))) return 'high';
      return 'medium';
    }

    if (classification === 'environment_issue') {
      // Environment issues depend on the specific problem
      if (indicators.some((i) => i.includes('unreachable') || i.includes('connection'))) return 'high';
      return 'medium';
    }

    return 'low';
  }

  /**
   * Generate a descriptive title for the bug
   */
  private generateTitle(
    classification: BugClassification,
    error: Error,
    observation: PageObservation
  ): string {
    const page = this.extractPageName(observation.url);

    switch (classification) {
      case 'app_bug': {
        // Check for specific app issues
        const serverErrors = observation.networkErrors.filter((e) => e.status && e.status >= 500);
        if (serverErrors.length > 0) {
          return `Server error ${serverErrors[0].status} on ${page}`;
        }
        if (observation.consoleErrors.length > 0) {
          return `JavaScript error on ${page}`;
        }
        return `Application error on ${page}: ${this.truncate(error.message, 50)}`;
      }

      case 'agent_bug':
        if (error.message.toLowerCase().includes('selector')) {
          return `Selector issue on ${page}`;
        }
        if (error.message.toLowerCase().includes('timeout')) {
          return `Timing issue on ${page}`;
        }
        return `Agent error on ${page}: ${this.truncate(error.message, 50)}`;

      case 'environment_issue':
        if (error.message.toLowerCase().includes('connection')) {
          return `Network connectivity issue`;
        }
        if (observation.networkErrors.some((e) => e.status === 401 || e.status === 403)) {
          return `Authentication expired`;
        }
        return `Environment issue: ${this.truncate(error.message, 50)}`;

      default:
        return `Unknown failure on ${page}: ${this.truncate(error.message, 50)}`;
    }
  }

  /**
   * Extract page name from URL
   */
  private extractPageName(url: string): string {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      if (path === '/' || !path) return 'home page';
      // Get last meaningful segment
      const segments = path.split('/').filter(Boolean);
      return segments[segments.length - 1] || 'page';
    } catch {
      return 'page';
    }
  }

  /**
   * Truncate string to max length
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + '...';
  }

  /**
   * Enrich bug with context from the diagnosis
   */
  private enrichBug(bug: DetectedBug, context: DiagnosisContext): DetectedBug {
    const { observation } = context;

    return {
      ...bug,
      url: observation.url,
      screenshots: observation.screenshot ? [observation.screenshot] : [],
      consoleErrors: observation.consoleErrors,
      networkErrors: observation.networkErrors,
      timestamp: new Date(),
      sessionId: '', // Will be set by caller
    };
  }
}
