/**
 * ConfigLoader - Reads and parses probe.config.yaml
 *
 * Loads configuration from YAML file and merges with CLI options.
 */

import { readFile, access } from 'node:fs/promises';
import { parse } from 'yaml';

/**
 * Raw configuration structure from YAML
 */
export interface ProbeConfig {
  app: {
    baseUrl: string;
    name: string;
  };
  browser: {
    headless: boolean;
    timeout: number;
    slowMo?: number;
  };
  model: {
    provider: string;
    model: string;
    maxTokens: number;
  };
  screenshots: {
    onError: boolean;
    onValidation: boolean;
    format: string;
    directory: string;
  };
  github: {
    appRepo: string;
    agentRepo: string;
    createIssues: boolean;
    labels: {
      appBug: string[];
      agentBug: string[];
    };
  };
  logging: {
    level: string;
    directory: string;
    retainDays: number;
  };
  agent: {
    maxRetries: number;
    healingStrategies: string[];
  };
}

/**
 * CLI options that can override config
 */
export interface CliOptions {
  config?: string;
  headless?: boolean;
  headed?: boolean;
  tag?: string[];
  bail?: boolean;
  report?: boolean;
  noIssues?: boolean;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: ProbeConfig = {
  app: {
    baseUrl: 'http://localhost:5173',
    name: 'Oblique CRM',
  },
  browser: {
    headless: false,
    timeout: 30000,
    slowMo: 0,
  },
  model: {
    provider: 'anthropic',
    model: 'claude-opus-4-5-20251101',
    maxTokens: 4096,
  },
  screenshots: {
    onError: true,
    onValidation: true,
    format: 'png',
    directory: './logs/screenshots',
  },
  github: {
    appRepo: 'owner/repo',
    agentRepo: 'owner/probe',
    createIssues: false,
    labels: {
      appBug: ['bug', 'probe-detected'],
      agentBug: ['bug', 'self-reported'],
    },
  },
  logging: {
    level: 'info',
    directory: './logs',
    retainDays: 30,
  },
  agent: {
    maxRetries: 3,
    healingStrategies: [
      'wait_and_retry',
      'refresh_and_retry',
      'alternative_selector',
    ],
  },
};

/**
 * ConfigLoader class for reading probe.config.yaml
 */
export class ConfigLoader {
  private configPath: string;

  constructor(configPath: string = 'probe.config.yaml') {
    this.configPath = configPath;
  }

  /**
   * Load configuration from file
   */
  async load(): Promise<ProbeConfig> {
    try {
      await access(this.configPath);
    } catch {
      console.warn(`Config file not found at ${this.configPath}, using defaults`);
      return { ...DEFAULT_CONFIG };
    }

    const content = await readFile(this.configPath, 'utf-8');
    const parsed = parse(content) as Partial<ProbeConfig>;

    return this.mergeWithDefaults(parsed);
  }

  /**
   * Load configuration and merge with CLI options
   */
  async loadWithOptions(options: CliOptions): Promise<ProbeConfig> {
    const config = await this.load();

    // Apply CLI overrides
    if (options.headless) {
      config.browser.headless = true;
    } else if (options.headed) {
      config.browser.headless = false;
    }

    if (options.noIssues) {
      config.github.createIssues = false;
    }

    return config;
  }

  /**
   * Merge parsed config with defaults
   */
  private mergeWithDefaults(parsed: Partial<ProbeConfig>): ProbeConfig {
    return {
      app: {
        ...DEFAULT_CONFIG.app,
        ...parsed.app,
      },
      browser: {
        ...DEFAULT_CONFIG.browser,
        ...parsed.browser,
      },
      model: {
        ...DEFAULT_CONFIG.model,
        ...parsed.model,
      },
      screenshots: {
        ...DEFAULT_CONFIG.screenshots,
        ...parsed.screenshots,
      },
      github: {
        ...DEFAULT_CONFIG.github,
        ...parsed.github,
        labels: {
          ...DEFAULT_CONFIG.github.labels,
          ...parsed.github?.labels,
        },
      },
      logging: {
        ...DEFAULT_CONFIG.logging,
        ...parsed.logging,
      },
      agent: {
        ...DEFAULT_CONFIG.agent,
        ...parsed.agent,
      },
    };
  }
}
