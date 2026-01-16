/**
 * ClaudeClient - Anthropic API wrapper for Probe
 *
 * Handles communication with Claude for planning actions,
 * validating results, and diagnosing bugs.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ActionPlan, PageObservation, DetectedBug } from '../agent/types.js';
import { OBSERVE_PROMPT, PLAN_PROMPT, VALIDATE_PROMPT, DIAGNOSE_PROMPT } from './prompts/index.js';

export interface ClaudeConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface PlanRequest {
  goal: string;
  observation: PageObservation;
  previousActions?: string[];
}

export interface ValidationRequest {
  step: { name: string; goal: string };
  beforeObservation: PageObservation;
  afterObservation: PageObservation;
  expectedOutcome: string;
}

export interface DiagnosisRequest {
  step: { name: string; goal: string };
  error: Error;
  observation: PageObservation;
  actionHistory: string[];
}

type ContentBlock = Anthropic.ContentBlock;
type ImageBlockParam = Anthropic.ImageBlockParam;
type TextBlockParam = Anthropic.TextBlockParam;

export class ClaudeClient {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(config: ClaudeConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
    this.maxTokens = config.maxTokens;
  }

  async planActions(request: PlanRequest): Promise<ActionPlan> {
    const content = this.buildObservationMessage(request.observation, request.goal);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: PLAN_PROMPT,
      messages: [{ role: 'user', content }],
    });

    return this.parseActionPlan(response.content);
  }

  async validateAction(request: ValidationRequest): Promise<{ passed: boolean; reason: string }> {
    const content = this.buildValidationMessage(request);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: VALIDATE_PROMPT,
      messages: [{ role: 'user', content }],
    });

    return this.parseValidation(response.content);
  }

  async diagnoseBug(request: DiagnosisRequest): Promise<DetectedBug> {
    const content = this.buildDiagnosisMessage(request);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: DIAGNOSE_PROMPT,
      messages: [{ role: 'user', content }],
    });

    return this.parseDiagnosis(response.content);
  }

  private buildObservationMessage(
    observation: PageObservation,
    goal: string
  ): (TextBlockParam | ImageBlockParam)[] {
    const blocks: (TextBlockParam | ImageBlockParam)[] = [];

    // Page context
    blocks.push({
      type: 'text',
      text: `## Goal
${goal}

## Current Page State
URL: ${observation.url}
Title: ${observation.title}
Loading: ${observation.loadingIndicators ? 'Yes' : 'No'}
Console Errors: ${observation.consoleErrors.length > 0 ? observation.consoleErrors.join('; ') : 'None'}
Network Errors: ${observation.networkErrors.length > 0 ? observation.networkErrors.map(e => `${e.url}: ${e.status || e.error}`).join('; ') : 'None'}

## Toasts/Notifications
${observation.toasts.length > 0 ? observation.toasts.map(t => `[${t.type}] ${t.message}`).join('\n') : 'None'}

## Modals
${observation.modals.length > 0 ? observation.modals.filter(m => m.visible).map(m => m.title).join(', ') : 'None visible'}

## Interactive Elements
${observation.interactiveElements.filter(e => e.visible).map(e => this.formatElement(e)).join('\n')}

## Forms
${observation.forms.length > 0 ? observation.forms.map(f => this.formatForm(f)).join('\n\n') : 'No forms detected'}
`,
    });

    // Screenshot if available
    if (observation.screenshot) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: observation.screenshot,
        },
      });
    }

    return blocks;
  }

  private formatElement(el: PageObservation['interactiveElements'][0]): string {
    const parts = [`[${el.id}] ${el.type}`];
    if (el.text) parts.push(`"${el.text.slice(0, 50)}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`);
    if (el.disabled) parts.push('(disabled)');
    if (el.value) parts.push(`value="${el.value.slice(0, 20)}"`);
    return parts.join(' ');
  }

  private formatForm(form: PageObservation['forms'][0]): string {
    return `Form: ${form.id}
Fields:
${form.fields.map(f => `  - ${f.label || f.name} (${f.type})${f.required ? ' *' : ''}${f.value ? ` = "${f.value}"` : ''}`).join('\n')}`;
  }

  private buildValidationMessage(request: ValidationRequest): (TextBlockParam | ImageBlockParam)[] {
    return [
      {
        type: 'text',
        text: `## Validation Request

Step: ${request.step.name}
Goal: ${request.step.goal}
Expected Outcome: ${request.expectedOutcome}

## Before State
URL: ${request.beforeObservation.url}

## After State
URL: ${request.afterObservation.url}
Toasts: ${request.afterObservation.toasts.map(t => `[${t.type}] ${t.message}`).join('; ') || 'None'}
Errors: ${request.afterObservation.consoleErrors.join('; ') || 'None'}

Did the action achieve the expected outcome? Respond with JSON:
{ "passed": true/false, "reason": "explanation" }`,
      },
    ];
  }

  private buildDiagnosisMessage(request: DiagnosisRequest): (TextBlockParam | ImageBlockParam)[] {
    const blocks: (TextBlockParam | ImageBlockParam)[] = [
      {
        type: 'text',
        text: `## Bug Diagnosis Request

Step: ${request.step.name}
Goal: ${request.step.goal}

## Error
${request.error.message}
${request.error.stack || ''}

## Page State
URL: ${request.observation.url}
Console Errors: ${request.observation.consoleErrors.join('\n') || 'None'}
Network Errors: ${request.observation.networkErrors.map(e => `${e.method} ${e.url}: ${e.status || e.error}`).join('\n') || 'None'}

## Recent Actions
${request.actionHistory.join('\n')}

Analyze this failure and classify it. Respond with JSON:
{
  "classification": "app_bug" | "agent_bug" | "environment_issue" | "unknown",
  "confidence": 0.0-1.0,
  "title": "short description",
  "description": "detailed explanation",
  "severity": "critical" | "high" | "medium" | "low",
  "reproductionSteps": ["step1", "step2"],
  "expectedBehavior": "what should happen",
  "actualBehavior": "what happened"
}`,
      },
    ];

    if (request.observation.screenshot) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: request.observation.screenshot,
        },
      });
    }

    return blocks;
  }

  private parseActionPlan(content: ContentBlock[]): ActionPlan {
    const text = content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Extract JSON from response
    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in Claude response');
    }

    return JSON.parse(jsonMatch[0]) as ActionPlan;
  }

  private parseValidation(content: ContentBlock[]): { passed: boolean; reason: string } {
    const text = content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in Claude response');
    }

    return JSON.parse(jsonMatch[0]);
  }

  private parseDiagnosis(content: ContentBlock[]): DetectedBug {
    const text = content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in Claude response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      ...parsed,
      screenshots: [],
      consoleErrors: [],
      networkErrors: [],
      url: '',
      timestamp: new Date(),
      sessionId: '',
    } as DetectedBug;
  }
}
