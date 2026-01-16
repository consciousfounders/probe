# Probe

AI-powered test agent for Oblique CRM - self-healing browser automation with Claude.

## Features

- **AI-Driven Testing**: Uses Claude Opus 4.5 to understand pages and decide actions
- **Self-Healing**: Automatically recovers from failures using multiple strategies
- **Bug Detection**: Classifies bugs as app bugs vs agent bugs
- **Auto-Reporting**: Creates GitHub issues for detected bugs
- **YAML Scenarios**: Define tests in natural language

## Installation

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
# Run test scenarios
npx probe run

# Interactive watch mode
npx probe watch --url http://localhost:5173

# Free exploration mode
npx probe explore --duration 30

# View reports
npx probe report
```

## Configuration

Edit `probe.config.yaml` to configure:
- Target application URL
- Browser settings (headed/headless)
- AI model settings
- Bug reporting repos

## Scenarios

Define test scenarios in `scenarios/` directory using YAML:

```yaml
name: Lead CRUD
steps:
  - name: Create Lead
    goal: Click "Add Lead", fill the form, submit
    assertions:
      - type: toast
        value: contains:created
```

## Architecture

```
Observer → Planner → Executor → Validator
     ↑                              ↓
     └──── SelfHealer ←────────────┘
```

## License

MIT
