/**
 * ScenarioLoader - Loads and parses YAML scenario files
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { parse } from 'yaml';
import type {
  Scenario,
  ScenarioStep,
  SetupConfig,
  TeardownConfig,
  AuthConfig,
  Assertion,
} from '../agent/types.js';

/**
 * Validation error details
 */
export interface ValidationError {
  path: string;
  message: string;
  value?: unknown;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Valid assertion types
 */
const VALID_ASSERTION_TYPES = [
  'url',
  'element_exists',
  'element_text',
  'element_value',
  'toast',
  'no_errors',
] as const;

/**
 * Valid auth types
 */
const VALID_AUTH_TYPES = ['google', 'email', 'session'] as const;

/**
 * Valid screenshot options
 */
const VALID_SCREENSHOT_OPTIONS = ['always', 'on_error', 'never'] as const;

/**
 * Valid assertion operators
 */
const VALID_OPERATORS = ['equals', 'contains', 'matches', 'not_equals'] as const;

/**
 * ScenarioLoader class for loading and parsing YAML scenario files
 */
export class ScenarioLoader {
  private scenariosDir: string;

  constructor(scenariosDir: string) {
    this.scenariosDir = scenariosDir;
  }

  /**
   * Load a single scenario from a file path
   */
  async load(path: string): Promise<Scenario> {
    const fullPath = this.resolvePath(path);
    const content = await readFile(fullPath, 'utf-8');
    const raw = parse(content) as unknown;

    const validationResult = this.validate(raw as Scenario);
    if (!validationResult.valid) {
      const errorMessages = validationResult.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ');
      throw new Error(`Invalid scenario file "${path}": ${errorMessages}`);
    }

    return this.normalizeScenario(raw);
  }

  /**
   * Load all scenarios from the scenarios directory
   */
  async loadAll(): Promise<Scenario[]> {
    const files = await this.getYamlFiles(this.scenariosDir);
    const scenarios: Scenario[] = [];

    for (const file of files) {
      try {
        const scenario = await this.load(file);
        scenarios.push(scenario);
      } catch (error) {
        // Re-throw with file context
        if (error instanceof Error) {
          throw new Error(`Failed to load scenario from "${file}": ${error.message}`);
        }
        throw error;
      }
    }

    return scenarios;
  }

  /**
   * Load scenarios that match any of the given tags
   */
  async loadByTags(tags: string[]): Promise<Scenario[]> {
    const allScenarios = await this.loadAll();
    return allScenarios.filter((scenario) => {
      if (!scenario.tags || scenario.tags.length === 0) {
        return false;
      }
      return tags.some((tag) => scenario.tags!.includes(tag));
    });
  }

  /**
   * Validate a scenario object
   */
  validate(scenario: Scenario): ValidationResult {
    const errors: ValidationError[] = [];

    // Check required 'name' field
    if (!scenario || typeof scenario !== 'object') {
      errors.push({
        path: 'scenario',
        message: 'Scenario must be an object',
        value: scenario,
      });
      return { valid: false, errors };
    }

    if (!scenario.name || typeof scenario.name !== 'string') {
      errors.push({
        path: 'name',
        message: 'Name is required and must be a string',
        value: scenario.name,
      });
    }

    // Optional 'description' field
    if (scenario.description !== undefined && typeof scenario.description !== 'string') {
      errors.push({
        path: 'description',
        message: 'Description must be a string',
        value: scenario.description,
      });
    }

    // Optional 'tags' field
    if (scenario.tags !== undefined) {
      if (!Array.isArray(scenario.tags)) {
        errors.push({
          path: 'tags',
          message: 'Tags must be an array',
          value: scenario.tags,
        });
      } else {
        scenario.tags.forEach((tag, index) => {
          if (typeof tag !== 'string') {
            errors.push({
              path: `tags[${index}]`,
              message: 'Tag must be a string',
              value: tag,
            });
          }
        });
      }
    }

    // Validate setup
    if (scenario.setup !== undefined) {
      this.validateSetup(scenario.setup, errors);
    }

    // Required 'steps' field
    if (!scenario.steps || !Array.isArray(scenario.steps)) {
      errors.push({
        path: 'steps',
        message: 'Steps is required and must be an array',
        value: scenario.steps,
      });
    } else if (scenario.steps.length === 0) {
      errors.push({
        path: 'steps',
        message: 'Steps must have at least one step',
        value: scenario.steps,
      });
    } else {
      scenario.steps.forEach((step, index) => {
        this.validateStep(step, `steps[${index}]`, errors);
      });
    }

    // Validate teardown
    if (scenario.teardown !== undefined) {
      this.validateTeardown(scenario.teardown, errors);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Resolve a path relative to the scenarios directory
   */
  private resolvePath(path: string): string {
    // If it's an absolute path, use it directly
    if (path.startsWith('/')) {
      return path;
    }
    return join(this.scenariosDir, path);
  }

  /**
   * Get all YAML files from a directory
   */
  private async getYamlFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir);
    const yamlFiles: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const fileStat = await stat(fullPath);

      if (fileStat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (ext === '.yaml' || ext === '.yml') {
          yamlFiles.push(entry);
        }
      }
    }

    return yamlFiles;
  }

  /**
   * Normalize a raw parsed YAML object into a Scenario
   */
  private normalizeScenario(raw: unknown): Scenario {
    const obj = raw as Record<string, unknown>;

    const scenario: Scenario = {
      name: obj.name as string,
      steps: this.normalizeSteps(obj.steps as unknown[]),
    };

    if (obj.description) {
      scenario.description = obj.description as string;
    }

    if (obj.tags) {
      scenario.tags = obj.tags as string[];
    }

    if (obj.setup) {
      scenario.setup = this.normalizeSetup(obj.setup as Record<string, unknown>);
    }

    if (obj.teardown) {
      scenario.teardown = this.normalizeTeardown(obj.teardown as Record<string, unknown>);
    }

    return scenario;
  }

  /**
   * Normalize setup configuration
   */
  private normalizeSetup(raw: Record<string, unknown>): SetupConfig {
    const setup: SetupConfig = {};

    if (raw.auth) {
      const authRaw = raw.auth as Record<string, unknown>;
      const auth: AuthConfig = {
        type: authRaw.type as 'google' | 'email' | 'session',
      };
      if (authRaw.sessionFile) {
        auth.sessionFile = authRaw.sessionFile as string;
      }
      setup.auth = auth;
    }

    if (raw.preconditions) {
      setup.preconditions = raw.preconditions as string[];
    }

    return setup;
  }

  /**
   * Normalize teardown configuration
   */
  private normalizeTeardown(raw: Record<string, unknown>): TeardownConfig {
    const teardown: TeardownConfig = {};

    if (raw.cleanup) {
      teardown.cleanup = raw.cleanup as string[];
    }

    return teardown;
  }

  /**
   * Normalize steps array
   */
  private normalizeSteps(raw: unknown[]): ScenarioStep[] {
    return raw.map((step) => this.normalizeStep(step as Record<string, unknown>));
  }

  /**
   * Normalize a single step
   */
  private normalizeStep(raw: Record<string, unknown>): ScenarioStep {
    const step: ScenarioStep = {
      name: raw.name as string,
      goal: raw.goal as string,
    };

    if (raw.startUrl) {
      step.startUrl = raw.startUrl as string;
    }

    if (raw.assertions) {
      step.assertions = this.normalizeAssertions(raw.assertions as unknown[]);
    }

    if (raw.maxAttempts !== undefined) {
      step.maxAttempts = raw.maxAttempts as number;
    }

    if (raw.timeout !== undefined) {
      step.timeout = raw.timeout as number;
    }

    if (raw.screenshot) {
      step.screenshot = raw.screenshot as 'always' | 'on_error' | 'never';
    }

    return step;
  }

  /**
   * Normalize assertions array
   */
  private normalizeAssertions(raw: unknown[]): Assertion[] {
    return raw.map((assertion) => {
      const a = assertion as Record<string, unknown>;
      const normalized: Assertion = {
        type: a.type as Assertion['type'],
      };

      if (a.target) {
        normalized.target = a.target as string;
      }

      if (a.value) {
        normalized.value = a.value as string;
      }

      if (a.operator) {
        normalized.operator = a.operator as Assertion['operator'];
      }

      return normalized;
    });
  }

  /**
   * Validate setup configuration
   */
  private validateSetup(setup: SetupConfig, errors: ValidationError[]): void {
    if (typeof setup !== 'object' || setup === null) {
      errors.push({
        path: 'setup',
        message: 'Setup must be an object',
        value: setup,
      });
      return;
    }

    if (setup.auth !== undefined) {
      this.validateAuth(setup.auth, errors);
    }

    if (setup.preconditions !== undefined) {
      if (!Array.isArray(setup.preconditions)) {
        errors.push({
          path: 'setup.preconditions',
          message: 'Preconditions must be an array',
          value: setup.preconditions,
        });
      } else {
        setup.preconditions.forEach((pc, index) => {
          if (typeof pc !== 'string') {
            errors.push({
              path: `setup.preconditions[${index}]`,
              message: 'Precondition must be a string',
              value: pc,
            });
          }
        });
      }
    }
  }

  /**
   * Validate auth configuration
   */
  private validateAuth(auth: AuthConfig, errors: ValidationError[]): void {
    if (typeof auth !== 'object' || auth === null) {
      errors.push({
        path: 'setup.auth',
        message: 'Auth must be an object',
        value: auth,
      });
      return;
    }

    if (!auth.type) {
      errors.push({
        path: 'setup.auth.type',
        message: 'Auth type is required',
        value: auth.type,
      });
    } else if (!VALID_AUTH_TYPES.includes(auth.type as typeof VALID_AUTH_TYPES[number])) {
      errors.push({
        path: 'setup.auth.type',
        message: `Invalid auth type. Must be one of: ${VALID_AUTH_TYPES.join(', ')}`,
        value: auth.type,
      });
    }

    if (auth.sessionFile !== undefined && typeof auth.sessionFile !== 'string') {
      errors.push({
        path: 'setup.auth.sessionFile',
        message: 'Session file must be a string',
        value: auth.sessionFile,
      });
    }
  }

  /**
   * Validate teardown configuration
   */
  private validateTeardown(teardown: TeardownConfig, errors: ValidationError[]): void {
    if (typeof teardown !== 'object' || teardown === null) {
      errors.push({
        path: 'teardown',
        message: 'Teardown must be an object',
        value: teardown,
      });
      return;
    }

    if (teardown.cleanup !== undefined) {
      if (!Array.isArray(teardown.cleanup)) {
        errors.push({
          path: 'teardown.cleanup',
          message: 'Cleanup must be an array',
          value: teardown.cleanup,
        });
      } else {
        teardown.cleanup.forEach((item, index) => {
          if (typeof item !== 'string') {
            errors.push({
              path: `teardown.cleanup[${index}]`,
              message: 'Cleanup item must be a string',
              value: item,
            });
          }
        });
      }
    }
  }

  /**
   * Validate a single step
   */
  private validateStep(step: ScenarioStep, path: string, errors: ValidationError[]): void {
    if (typeof step !== 'object' || step === null) {
      errors.push({
        path,
        message: 'Step must be an object',
        value: step,
      });
      return;
    }

    // Required 'name' field
    if (!step.name || typeof step.name !== 'string') {
      errors.push({
        path: `${path}.name`,
        message: 'Step name is required and must be a string',
        value: step.name,
      });
    }

    // Required 'goal' field
    if (!step.goal || typeof step.goal !== 'string') {
      errors.push({
        path: `${path}.goal`,
        message: 'Step goal is required and must be a string',
        value: step.goal,
      });
    }

    // Optional 'startUrl' field
    if (step.startUrl !== undefined && typeof step.startUrl !== 'string') {
      errors.push({
        path: `${path}.startUrl`,
        message: 'Start URL must be a string',
        value: step.startUrl,
      });
    }

    // Optional 'maxAttempts' field
    if (step.maxAttempts !== undefined) {
      if (typeof step.maxAttempts !== 'number' || step.maxAttempts < 1) {
        errors.push({
          path: `${path}.maxAttempts`,
          message: 'Max attempts must be a positive number',
          value: step.maxAttempts,
        });
      }
    }

    // Optional 'timeout' field
    if (step.timeout !== undefined) {
      if (typeof step.timeout !== 'number' || step.timeout < 0) {
        errors.push({
          path: `${path}.timeout`,
          message: 'Timeout must be a non-negative number',
          value: step.timeout,
        });
      }
    }

    // Optional 'screenshot' field
    if (step.screenshot !== undefined) {
      if (!VALID_SCREENSHOT_OPTIONS.includes(step.screenshot as typeof VALID_SCREENSHOT_OPTIONS[number])) {
        errors.push({
          path: `${path}.screenshot`,
          message: `Invalid screenshot option. Must be one of: ${VALID_SCREENSHOT_OPTIONS.join(', ')}`,
          value: step.screenshot,
        });
      }
    }

    // Optional 'assertions' field
    if (step.assertions !== undefined) {
      if (!Array.isArray(step.assertions)) {
        errors.push({
          path: `${path}.assertions`,
          message: 'Assertions must be an array',
          value: step.assertions,
        });
      } else {
        step.assertions.forEach((assertion, index) => {
          this.validateAssertion(assertion, `${path}.assertions[${index}]`, errors);
        });
      }
    }
  }

  /**
   * Validate a single assertion
   */
  private validateAssertion(assertion: Assertion, path: string, errors: ValidationError[]): void {
    if (typeof assertion !== 'object' || assertion === null) {
      errors.push({
        path,
        message: 'Assertion must be an object',
        value: assertion,
      });
      return;
    }

    // Required 'type' field
    if (!assertion.type) {
      errors.push({
        path: `${path}.type`,
        message: 'Assertion type is required',
        value: assertion.type,
      });
    } else if (!VALID_ASSERTION_TYPES.includes(assertion.type as typeof VALID_ASSERTION_TYPES[number])) {
      errors.push({
        path: `${path}.type`,
        message: `Invalid assertion type. Must be one of: ${VALID_ASSERTION_TYPES.join(', ')}`,
        value: assertion.type,
      });
    }

    // Optional 'target' field
    if (assertion.target !== undefined && typeof assertion.target !== 'string') {
      errors.push({
        path: `${path}.target`,
        message: 'Assertion target must be a string',
        value: assertion.target,
      });
    }

    // Optional 'value' field
    if (assertion.value !== undefined && typeof assertion.value !== 'string') {
      errors.push({
        path: `${path}.value`,
        message: 'Assertion value must be a string',
        value: assertion.value,
      });
    }

    // Optional 'operator' field
    if (assertion.operator !== undefined) {
      if (!VALID_OPERATORS.includes(assertion.operator as typeof VALID_OPERATORS[number])) {
        errors.push({
          path: `${path}.operator`,
          message: `Invalid operator. Must be one of: ${VALID_OPERATORS.join(', ')}`,
          value: assertion.operator,
        });
      }
    }
  }
}
