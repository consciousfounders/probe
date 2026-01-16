/**
 * ReportGenerator - Generates human-readable HTML reports from session logs
 */

import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { DetectedBug, ScenarioStep, PageObservation, ActionPlan, ExecutedAction } from '../agent/types.js';

/**
 * Session summary data structure
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
 * Step log entry for report generation
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
 * ReportGenerator class for creating HTML reports
 */
export class ReportGenerator {
  /**
   * Generate HTML report from session data
   */
  generateHTML(summary: SessionSummary, stepLogs: StepLog[], sessionDir: string): string {
    const statusClass = summary.status === 'passed' ? 'success' : summary.status === 'failed' ? 'failure' : 'running';
    const statusIcon = summary.status === 'passed' ? '&#10003;' : summary.status === 'failed' ? '&#10007;' : '&#8634;';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Probe Test Report - ${summary.sessionId}</title>
  <style>
    ${this.getStyles()}
  </style>
</head>
<body>
  <div class="container">
    ${this.generateHeader(summary, statusClass, statusIcon)}
    ${this.generateSummarySection(summary)}
    ${this.generateStepsSection(summary, stepLogs, sessionDir)}
    ${this.generateBugsSection(summary.bugs)}
    ${this.generateFooter()}
  </div>
</body>
</html>`;
  }

  /**
   * Generate CSS styles for the report
   */
  private getStyles(): string {
    return `
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }

    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 10px;
      margin-bottom: 20px;
    }

    header h1 {
      font-size: 24px;
      margin-bottom: 10px;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 20px;
      font-weight: 600;
      font-size: 14px;
    }

    .status-badge.success {
      background: rgba(72, 187, 120, 0.2);
      color: #48bb78;
    }

    .status-badge.failure {
      background: rgba(245, 101, 101, 0.2);
      color: #fc8181;
    }

    .status-badge.running {
      background: rgba(236, 201, 75, 0.2);
      color: #ecc94b;
    }

    .meta {
      display: flex;
      gap: 20px;
      margin-top: 15px;
      font-size: 14px;
      opacity: 0.9;
    }

    section {
      background: white;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    section h2 {
      font-size: 18px;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #f0f0f0;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
    }

    .summary-card {
      text-align: center;
      padding: 15px;
      background: #f9f9f9;
      border-radius: 8px;
    }

    .summary-card .value {
      font-size: 32px;
      font-weight: 700;
      color: #667eea;
    }

    .summary-card .label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .step {
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      margin-bottom: 15px;
      overflow: hidden;
    }

    .step-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 15px;
      background: #f9f9f9;
      cursor: pointer;
    }

    .step-header:hover {
      background: #f0f0f0;
    }

    .step-icon {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 14px;
    }

    .step-icon.passed {
      background: #c6f6d5;
      color: #276749;
    }

    .step-icon.failed {
      background: #fed7d7;
      color: #c53030;
    }

    .step-icon.pending {
      background: #e2e8f0;
      color: #718096;
    }

    .step-icon.running {
      background: #fefcbf;
      color: #975a16;
    }

    .step-title {
      flex: 1;
      font-weight: 500;
    }

    .step-meta {
      font-size: 12px;
      color: #666;
    }

    .step-details {
      padding: 15px;
      border-top: 1px solid #e0e0e0;
      display: none;
    }

    .step.expanded .step-details {
      display: block;
    }

    .detail-section {
      margin-bottom: 15px;
    }

    .detail-section h4 {
      font-size: 12px;
      text-transform: uppercase;
      color: #666;
      margin-bottom: 8px;
    }

    .action-list {
      list-style: none;
    }

    .action-list li {
      padding: 8px 12px;
      background: #f9f9f9;
      border-radius: 4px;
      margin-bottom: 5px;
      font-family: monospace;
      font-size: 13px;
    }

    .action-list li.success {
      border-left: 3px solid #48bb78;
    }

    .action-list li.failure {
      border-left: 3px solid #fc8181;
    }

    .error-box {
      background: #fff5f5;
      border: 1px solid #fc8181;
      border-radius: 4px;
      padding: 12px;
      font-family: monospace;
      font-size: 13px;
      color: #c53030;
      white-space: pre-wrap;
      overflow-x: auto;
    }

    .screenshot-container {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
    }

    .screenshot {
      max-width: 400px;
    }

    .screenshot img {
      width: 100%;
      border-radius: 4px;
      border: 1px solid #e0e0e0;
    }

    .screenshot .label {
      font-size: 12px;
      color: #666;
      margin-top: 5px;
    }

    .bug-card {
      border: 1px solid #fc8181;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
      background: #fff5f5;
    }

    .bug-card h4 {
      color: #c53030;
      margin-bottom: 10px;
    }

    .bug-severity {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .bug-severity.critical {
      background: #c53030;
      color: white;
    }

    .bug-severity.high {
      background: #dd6b20;
      color: white;
    }

    .bug-severity.medium {
      background: #d69e2e;
      color: white;
    }

    .bug-severity.low {
      background: #38a169;
      color: white;
    }

    footer {
      text-align: center;
      padding: 20px;
      color: #666;
      font-size: 12px;
    }

    footer a {
      color: #667eea;
      text-decoration: none;
    }

    .collapsible {
      cursor: pointer;
      user-select: none;
    }

    .collapsible::after {
      content: ' \\25BC';
      font-size: 10px;
    }

    .collapsed .collapsible::after {
      content: ' \\25B6';
    }
    `;
  }

  /**
   * Generate header section
   */
  private generateHeader(summary: SessionSummary, statusClass: string, statusIcon: string): string {
    return `
    <header>
      <h1>Probe Test Report</h1>
      <span class="status-badge ${statusClass}">
        <span>${statusIcon}</span>
        ${summary.status.toUpperCase()}
      </span>
      <div class="meta">
        <span><strong>Session:</strong> ${summary.sessionId}</span>
        ${summary.scenarioName ? `<span><strong>Scenario:</strong> ${summary.scenarioName}</span>` : ''}
        <span><strong>Started:</strong> ${this.formatDate(summary.startTime)}</span>
        ${summary.endTime ? `<span><strong>Ended:</strong> ${this.formatDate(summary.endTime)}</span>` : ''}
      </div>
    </header>`;
  }

  /**
   * Generate summary section
   */
  private generateSummarySection(summary: SessionSummary): string {
    const totalSteps = summary.steps.length;
    const passedSteps = summary.steps.filter((s) => s.status === 'passed').length;
    const failedSteps = summary.steps.filter((s) => s.status === 'failed').length;
    const duration = summary.totalDuration ? this.formatDuration(summary.totalDuration) : '-';

    return `
    <section>
      <h2>Summary</h2>
      <div class="summary-grid">
        <div class="summary-card">
          <div class="value">${totalSteps}</div>
          <div class="label">Total Steps</div>
        </div>
        <div class="summary-card">
          <div class="value" style="color: #48bb78">${passedSteps}</div>
          <div class="label">Passed</div>
        </div>
        <div class="summary-card">
          <div class="value" style="color: #fc8181">${failedSteps}</div>
          <div class="label">Failed</div>
        </div>
        <div class="summary-card">
          <div class="value">${summary.bugs.length}</div>
          <div class="label">Bugs Found</div>
        </div>
        <div class="summary-card">
          <div class="value">${duration}</div>
          <div class="label">Duration</div>
        </div>
      </div>
    </section>`;
  }

  /**
   * Generate steps section
   */
  private generateStepsSection(summary: SessionSummary, stepLogs: StepLog[], sessionDir: string): string {
    const stepsHtml = summary.steps
      .map((step, index) => {
        const log = stepLogs[index];
        return this.generateStepCard(step, log, index + 1, sessionDir);
      })
      .join('');

    return `
    <section>
      <h2>Step-by-Step Breakdown</h2>
      ${stepsHtml}
    </section>`;
  }

  /**
   * Generate a single step card
   */
  private generateStepCard(
    step: SessionSummary['steps'][0],
    log: StepLog | undefined,
    index: number,
    sessionDir: string
  ): string {
    const statusIcon = step.status === 'passed' ? '&#10003;' : step.status === 'failed' ? '&#10007;' : '&#8226;';
    const duration = step.duration ? this.formatDuration(step.duration) : '-';

    let detailsHtml = '';
    if (log) {
      detailsHtml = this.generateStepDetails(log, index, sessionDir);
    }

    return `
    <div class="step" onclick="this.classList.toggle('expanded')">
      <div class="step-header">
        <div class="step-icon ${step.status}">${statusIcon}</div>
        <div class="step-title">${index}. ${this.escapeHtml(step.name)}</div>
        <div class="step-meta">
          ${step.attempts > 0 ? `${step.attempts} attempt${step.attempts > 1 ? 's' : ''}` : ''}
          &bull; ${duration}
        </div>
      </div>
      <div class="step-details">
        ${detailsHtml}
        ${step.error ? `<div class="detail-section"><h4>Error</h4><div class="error-box">${this.escapeHtml(step.error)}</div></div>` : ''}
      </div>
    </div>`;
  }

  /**
   * Generate step details
   */
  private generateStepDetails(log: StepLog, index: number, sessionDir: string): string {
    let html = '';

    // Goal
    html += `
    <div class="detail-section">
      <h4>Goal</h4>
      <p>${this.escapeHtml(log.step.goal)}</p>
    </div>`;

    // Actions
    if (log.actions.length > 0) {
      const actionsHtml = log.actions
        .map((action) => {
          const desc = `${action.plan.type} on "${action.plan.target}"${action.plan.value ? ` = "${action.plan.value}"` : ''}`;
          return `<li class="${action.success ? 'success' : 'failure'}">${this.escapeHtml(desc)}</li>`;
        })
        .join('');

      html += `
      <div class="detail-section">
        <h4>Actions Executed</h4>
        <ul class="action-list">${actionsHtml}</ul>
      </div>`;
    }

    // Plan reasoning
    if (log.plans.length > 0) {
      const lastPlan = log.plans[log.plans.length - 1];
      html += `
      <div class="detail-section">
        <h4>AI Reasoning</h4>
        <p>${this.escapeHtml(lastPlan.reasoning)}</p>
        <p><strong>Expected Outcome:</strong> ${this.escapeHtml(lastPlan.expectedOutcome)}</p>
        <p><strong>Confidence:</strong> ${(lastPlan.confidence * 100).toFixed(0)}%</p>
      </div>`;
    }

    return html;
  }

  /**
   * Generate bugs section
   */
  private generateBugsSection(bugs: DetectedBug[]): string {
    if (bugs.length === 0) {
      return `
      <section>
        <h2>Bugs Detected</h2>
        <p style="color: #666; font-style: italic;">No bugs detected during this session.</p>
      </section>`;
    }

    const bugsHtml = bugs
      .map(
        (bug) => `
      <div class="bug-card">
        <h4>${this.escapeHtml(bug.title)} <span class="bug-severity ${bug.severity}">${bug.severity}</span></h4>
        <p>${this.escapeHtml(bug.description)}</p>
        <div class="detail-section">
          <h4>Reproduction Steps</h4>
          <ol>
            ${bug.reproductionSteps.map((s) => `<li>${this.escapeHtml(s)}</li>`).join('')}
          </ol>
        </div>
        <div class="detail-section">
          <h4>Expected vs Actual</h4>
          <p><strong>Expected:</strong> ${this.escapeHtml(bug.expectedBehavior)}</p>
          <p><strong>Actual:</strong> ${this.escapeHtml(bug.actualBehavior)}</p>
        </div>
        ${bug.consoleErrors.length > 0 ? `<div class="error-box">${bug.consoleErrors.map((e) => this.escapeHtml(e)).join('\n')}</div>` : ''}
      </div>`
      )
      .join('');

    return `
    <section>
      <h2>Bugs Detected</h2>
      ${bugsHtml}
    </section>`;
  }

  /**
   * Generate footer
   */
  private generateFooter(): string {
    return `
    <footer>
      <p>Generated by <a href="https://github.com/consciousfounders/probe" target="_blank">Probe</a> - AI-powered test agent</p>
      <p>Report generated at ${new Date().toISOString()}</p>
    </footer>`;
  }

  /**
   * Format a date string
   */
  private formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleString();
  }

  /**
   * Format duration in milliseconds to human-readable string
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const htmlEntities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, (char) => htmlEntities[char]);
  }
}
