#!/usr/bin/env node
/**
 * Probe - AI-powered test agent for Oblique CRM
 *
 * CLI entry point
 */

import { Command } from 'commander';

const program = new Command();

program
  .name('probe')
  .description('AI-powered test agent for Oblique CRM')
  .version('0.1.0');

// TODO: Import and register commands from cli/commands/

program
  .command('run [scenarios...]')
  .description('Run test scenarios')
  .option('-c, --config <path>', 'Config file path', 'probe.config.yaml')
  .option('--headless', 'Run in headless mode')
  .option('--headed', 'Run in headed mode (default)')
  .action(async (scenarios, options) => {
    console.log('TODO: Implement run command');
    console.log('Scenarios:', scenarios);
    console.log('Options:', options);
  });

program
  .command('watch')
  .description('Interactive watch mode')
  .option('--url <url>', 'Starting URL')
  .action(async (options) => {
    console.log('TODO: Implement watch command');
    console.log('Options:', options);
  });

program
  .command('explore')
  .description('Free exploration mode')
  .option('--duration <minutes>', 'Exploration duration', '30')
  .action(async (options) => {
    console.log('TODO: Implement explore command');
    console.log('Options:', options);
  });

program
  .command('report [sessionId]')
  .description('View test reports')
  .option('--format <format>', 'Output format', 'html')
  .option('--open', 'Open in browser')
  .action(async (sessionId, options) => {
    console.log('TODO: Implement report command');
  });

program.parse();
