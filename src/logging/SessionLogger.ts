/**
 * SessionLogger - Comprehensive test execution logging
 *
 * Creates session directories, logs observations/plans/actions,
 * stores screenshots, and generates summary reports.
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ScenarioStep,
  PageObservation,
  ActionPlan,
  ExecutedAction,
  DetectedBug,
} from '../agent/types.js';

/**
 * Result of a scenario execution
 */
export interface ScenarioResult {
  scenarioName: string;
  success: boolean;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  duration: number;
  bugs: DetectedBug[];
  errors: string[];
}

/**
 * Step execution log entry
 */
interface StepLog {
  step: ScenarioStep;
  startTime: Date;
  endTime?: Date;
  observations: PageObservation[];
  plans: ActionPlan[];
  actions: ExecutedAction[];
  errors: Error[];
  success: boolean;
  attempts: number;
}

/**
 * Session summary data
 */
interface SessionSummary {
  sessionId: string;
  startTime: string;
  endTime?: string;
  scenarioName?: string;
  status: 'running' | 'passed' | 'failed';
  steps: {
    name: string;
    status: 'pending' | 'running' | 'passed' | 'failed';
    attempts: number;
    duration?: number;
    error?: string;
  }[];
  bugs: DetectedBug[];
  totalDuration?: number;
}

/**
 * SessionLogger class for comprehensive test execution logging
 */
export class SessionLogger {
  private logDir: string;
  private sessionId: string | null = null;
  private sessionDir: string | null = null;
  private sessionStartTime: Date | null = null;
  private currentStep: ScenarioStep | null = null;
  private currentStepIndex: number = 0;
  private currentStepDir: string | null = null;
  private stepLogs: StepLog[] = [];
  private recentActions: string[] = [];
  private allActions: string[] = [];
  private bugs: DetectedBug[] = [];
  private scenarioName: string | null = null;

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  /**
   * Start a new logging session
   * @returns The session ID
   */
  async startSession(): Promise<string> {
    const now = new Date();
    this.sessionId = this.generateSessionId(now);
    this.sessionStartTime = now;
    this.sessionDir = join(this.logDir, this.sessionId);
    this.stepLogs = [];
    this.recentActions = [];
    this.allActions = [];
    this.bugs = [];
    this.currentStepIndex = 0;

    // Create session directory structure
    await mkdir(this.sessionDir, { recursive: true });
    await mkdir(join(this.sessionDir, 'steps'), { recursive: true });

    // Write initial session.json
    await this.writeSessionSummary();

    return this.sessionId;
  }

  /**
   * Start logging for a new step
   */
  async startStep(step: ScenarioStep): Promise<void> {
    if (!this.sessionDir) {
      throw new Error('Session not started. Call startSession() first.');
    }

    this.currentStep = step;
    this.currentStepIndex++;

    // Create step directory with zero-padded index
    const stepDirName = `${String(this.currentStepIndex).padStart(2, '0')}_${this.sanitizeFileName(step.name)}`;
    this.currentStepDir = join(this.sessionDir, 'steps', stepDirName);
    await mkdir(this.currentStepDir, { recursive: true });

    // Initialize step log
    const stepLog: StepLog = {
      step,
      startTime: new Date(),
      observations: [],
      plans: [],
      actions: [],
      errors: [],
      success: false,
      attempts: 0,
    };
    this.stepLogs.push(stepLog);

    await this.writeSessionSummary();
  }

  /**
   * Log a page observation
   */
  async logObservation(obs: PageObservation): Promise<void> {
    if (!this.currentStepDir) {
      throw new Error('No step started. Call startStep() first.');
    }

    const currentLog = this.getCurrentStepLog();
    currentLog.observations.push(obs);

    // Write observation to file
    const obsPath = join(this.currentStepDir, 'observation.json');
    await writeFile(obsPath, JSON.stringify(obs, null, 2));
  }

  /**
   * Log an action plan
   */
  async logPlan(plan: ActionPlan): Promise<void> {
    if (!this.currentStepDir) {
      throw new Error('No step started. Call startStep() first.');
    }

    const currentLog = this.getCurrentStepLog();
    currentLog.plans.push(plan);

    // Write plan to file
    const planPath = join(this.currentStepDir, 'plan.json');
    await writeFile(planPath, JSON.stringify(plan, null, 2));
  }

  /**
   * Log an executed action
   */
  async logAction(action: ExecutedAction): Promise<void> {
    if (!this.currentStepDir) {
      throw new Error('No step started. Call startStep() first.');
    }

    const currentLog = this.getCurrentStepLog();
    currentLog.actions.push(action);

    // Create action description
    const actionDesc = `${action.plan.type} on ${action.plan.target}${action.plan.value ? ` with value "${action.plan.value}"` : ''} - ${action.success ? 'SUCCESS' : 'FAILED'}`;

    this.recentActions.push(actionDesc);
    this.allActions.push(actionDesc);

    // Keep only last 10 recent actions
    if (this.recentActions.length > 10) {
      this.recentActions.shift();
    }

    // Write actions to file
    const actionsPath = join(this.currentStepDir, 'actions.json');
    await writeFile(actionsPath, JSON.stringify(currentLog.actions, null, 2));
  }

  /**
   * Log an error
   */
  async logError(error: Error): Promise<void> {
    const currentLog = this.getCurrentStepLog();
    currentLog.errors.push(error);

    if (this.currentStepDir) {
      // Append error to errors file
      const errorsPath = join(this.currentStepDir, 'errors.json');
      const errors = currentLog.errors.map((e) => ({
        name: e.name,
        message: e.message,
        stack: e.stack,
      }));
      await writeFile(errorsPath, JSON.stringify(errors, null, 2));
    }

    await this.writeSessionSummary();
  }

  /**
   * Log successful step completion
   */
  async logSuccess(step: ScenarioStep, attempts: number): Promise<void> {
    const currentLog = this.getCurrentStepLog();
    currentLog.success = true;
    currentLog.attempts = attempts;
    currentLog.endTime = new Date();

    await this.writeSessionSummary();
  }

  /**
   * Log a detected bug
   */
  async logBug(bug: DetectedBug): Promise<void> {
    this.bugs.push(bug);

    if (this.currentStepDir) {
      const bugsPath = join(this.currentStepDir, 'bugs.json');
      await writeFile(bugsPath, JSON.stringify(this.bugs, null, 2));
    }

    await this.writeSessionSummary();
  }

  /**
   * Store a screenshot
   */
  async storeScreenshot(data: Buffer, name: string): Promise<string> {
    if (!this.currentStepDir) {
      throw new Error('No step started. Call startStep() first.');
    }

    const filename = `${name}.png`;
    const filepath = join(this.currentStepDir, filename);
    await writeFile(filepath, data);

    return filepath;
  }

  /**
   * Get recent actions (last 10)
   */
  getRecentActions(): string[] {
    return [...this.recentActions];
  }

  /**
   * Get full action history
   */
  getActionHistory(): string[] {
    return [...this.allActions];
  }

  /**
   * End the session and write final summary
   */
  async endSession(result: ScenarioResult): Promise<void> {
    if (!this.sessionDir) {
      throw new Error('Session not started.');
    }

    this.scenarioName = result.scenarioName;

    // Mark any running step as complete
    const currentLog = this.stepLogs[this.stepLogs.length - 1];
    if (currentLog && !currentLog.endTime) {
      currentLog.endTime = new Date();
      currentLog.success = result.success;
    }

    await this.writeSessionSummary(result);
  }

  /**
   * Generate HTML report
   * @returns Path to the generated report
   */
  async generateReport(): Promise<string> {
    if (!this.sessionDir || !this.sessionId) {
      throw new Error('Session not started.');
    }

    // Import ReportGenerator dynamically to avoid circular dependency
    const { ReportGenerator } = await import('./ReportGenerator.js');
    const generator = new ReportGenerator();

    const summary = await this.buildSessionSummary();
    const reportPath = join(this.sessionDir, 'report.html');

    const html = generator.generateHTML(summary, this.stepLogs, this.sessionDir);
    await writeFile(reportPath, html);

    return reportPath;
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get the session directory path
   */
  getSessionDir(): string | null {
    return this.sessionDir;
  }

  /**
   * Generate a unique session ID based on timestamp
   */
  private generateSessionId(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `session_${year}${month}${day}_${hours}${minutes}${seconds}`;
  }

  /**
   * Sanitize a string for use as a file name
   */
  private sanitizeFileName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 50);
  }

  /**
   * Get the current step log
   */
  private getCurrentStepLog(): StepLog {
    const log = this.stepLogs[this.stepLogs.length - 1];
    if (!log) {
      throw new Error('No step started.');
    }
    return log;
  }

  /**
   * Build session summary object
   */
  private async buildSessionSummary(result?: ScenarioResult): Promise<SessionSummary> {
    const summary: SessionSummary = {
      sessionId: this.sessionId!,
      startTime: this.sessionStartTime!.toISOString(),
      scenarioName: this.scenarioName ?? result?.scenarioName,
      status: result ? (result.success ? 'passed' : 'failed') : 'running',
      steps: this.stepLogs.map((log) => ({
        name: log.step.name,
        status: log.endTime
          ? log.success
            ? 'passed'
            : 'failed'
          : log.startTime
            ? 'running'
            : 'pending',
        attempts: log.attempts,
        duration: log.endTime
          ? log.endTime.getTime() - log.startTime.getTime()
          : undefined,
        error: log.errors.length > 0 ? log.errors[log.errors.length - 1].message : undefined,
      })),
      bugs: this.bugs,
    };

    if (result) {
      summary.endTime = new Date().toISOString();
      summary.totalDuration = result.duration;
    }

    return summary;
  }

  /**
   * Write session summary to session.json
   */
  private async writeSessionSummary(result?: ScenarioResult): Promise<void> {
    if (!this.sessionDir) return;

    const summary = await this.buildSessionSummary(result);
    const summaryPath = join(this.sessionDir, 'session.json');
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  }
}
