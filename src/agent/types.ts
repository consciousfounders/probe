/**
 * Core agent types for Probe
 */

export interface AgentConfig {
  baseUrl: string;
  headless: boolean;
  timeout: number;
  maxRetries: number;
  model: string;
  apiKey: string;
  githubToken?: string;
  appRepoOwner?: string;
  appRepoName?: string;
}

export type AgentPhase =
  | 'idle'
  | 'observing'
  | 'planning'
  | 'executing'
  | 'validating'
  | 'healing'
  | 'reporting'
  | 'complete'
  | 'failed';

export interface AgentState {
  phase: AgentPhase;
  currentScenario: Scenario | null;
  currentStep: number;
  pageUrl: string;
  lastObservation: PageObservation | null;
  lastPlan: ActionPlan | null;
  lastAction: ExecutedAction | null;
  errors: AgentError[];
  healingAttempts: number;
}

export interface AgentError {
  type: 'action_failed' | 'validation_failed' | 'timeout' | 'unexpected';
  message: string;
  screenshot?: string;
  timestamp: Date;
  context: Record<string, unknown>;
}

// Page understanding types
export interface PageObservation {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  forms: FormInfo[];
  modals: ModalInfo[];
  toasts: ToastInfo[];
  loadingIndicators: boolean;
  consoleErrors: string[];
  networkErrors: NetworkError[];
  screenshot?: string;
  timestamp: Date;
}

export interface InteractiveElement {
  id: string;
  type: 'button' | 'link' | 'input' | 'select' | 'checkbox' | 'radio' | 'textarea' | 'combobox';
  selector: string;
  playwrightLocator: string;
  text: string;
  placeholder?: string;
  value?: string;
  disabled: boolean;
  visible: boolean;
  ariaLabel?: string;
  role?: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface FormInfo {
  id: string;
  action?: string;
  method?: string;
  fields: FormFieldInfo[];
  submitButton?: InteractiveElement;
}

export interface FormFieldInfo {
  name: string;
  type: string;
  label?: string;
  required: boolean;
  value?: string;
  options?: string[];
  element: InteractiveElement;
}

export interface ModalInfo {
  title: string;
  visible: boolean;
}

export interface ToastInfo {
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
}

export interface NetworkError {
  url: string;
  method: string;
  status?: number;
  error?: string;
}

// AI planning types
export interface ActionPlan {
  reasoning: string;
  actions: PlannedAction[];
  expectedOutcome: string;
  confidence: number;
  alternativeStrategies?: string[];
}

export interface PlannedAction {
  type: ActionType;
  target: string;
  value?: string;
  description: string;
  waitAfter?: WaitCondition;
}

export type ActionType =
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'hover'
  | 'press'
  | 'scroll'
  | 'wait'
  | 'navigate';

export interface WaitCondition {
  type: 'url' | 'element' | 'network' | 'time' | 'text';
  value: string;
  timeout?: number;
}

export interface ExecutedAction {
  plan: PlannedAction;
  success: boolean;
  duration: number;
  error?: string;
  screenshot?: string;
}

// Scenario types
export interface Scenario {
  name: string;
  description?: string;
  tags?: string[];
  setup?: SetupConfig;
  steps: ScenarioStep[];
  teardown?: TeardownConfig;
}

export interface SetupConfig {
  auth?: AuthConfig;
  preconditions?: string[];
}

export interface AuthConfig {
  type: 'google' | 'email' | 'session';
  sessionFile?: string;
}

export interface TeardownConfig {
  cleanup?: string[];
}

export interface ScenarioStep {
  name: string;
  goal: string;
  startUrl?: string;
  assertions?: Assertion[];
  maxAttempts?: number;
  timeout?: number;
  screenshot?: 'always' | 'on_error' | 'never';
}

export interface Assertion {
  type: 'url' | 'element_exists' | 'element_text' | 'element_value' | 'toast' | 'no_errors';
  target?: string;
  value?: string;
  operator?: 'equals' | 'contains' | 'matches' | 'not_equals';
}

// Bug types
export type BugClassification =
  | 'app_bug'
  | 'agent_bug'
  | 'environment_issue'
  | 'test_issue'
  | 'unknown';

export interface DetectedBug {
  classification: BugClassification;
  confidence: number;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  reproductionSteps: string[];
  expectedBehavior: string;
  actualBehavior: string;
  screenshots: string[];
  consoleErrors: string[];
  networkErrors: NetworkError[];
  url: string;
  timestamp: Date;
  sessionId: string;
}

export type HealingStrategy =
  | 'wait_and_retry'
  | 'refresh_and_retry'
  | 'alternative_selector'
  | 'screenshot_analysis'
  | 'reset_to_known_state';
