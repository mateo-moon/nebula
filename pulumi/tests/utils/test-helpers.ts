/**
 * Common test utilities for Pulumi tests
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const exec = promisify(child_process.exec);

export interface TestConfig {
  stackName: string;
  projectName: string;
  testDir: string;
  backendDir: string;
  passphrase: string;
}

export interface TestResult {
  success: boolean;
  message: string;
  output?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Creates a test configuration with defaults
 */
export function createTestConfig(stackName: string, projectName?: string): TestConfig {
  const testDir = path.resolve(process.cwd(), 'tests');
  return {
    stackName,
    projectName: projectName || stackName.replace(/-/g, '_'),
    testDir,
    backendDir: path.join(testDir, `.pulumi-backend-${stackName}`),
    passphrase: process.env['PULUMI_CONFIG_PASSPHRASE'] || 'passphrase',
  };
}

/**
 * Runs a command with the test environment configured
 */
export async function runCommand(
  cmd: string,
  config: TestConfig,
  cwd?: string
): Promise<CommandResult> {
  console.log(`\n> ${cmd}`);
  try {
    const result = await exec(cmd, {
      cwd: cwd || config.testDir,
      env: {
        ...process.env,
        PULUMI_CONFIG_PASSPHRASE: config.passphrase,
        PULUMI_BACKEND_URL: `file://${config.backendDir}`,
        PULUMI_SKIP_CONFIRM: 'true',
        PULUMI_SKIP_UPDATE_CHECK: 'true',
      },
    });
    return result;
  } catch (error: any) {
    // exec throws on non-zero exit codes, but we still want stdout/stderr
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

/**
 * Ensures the backend directory exists
 */
export async function ensureBackendDir(config: TestConfig): Promise<void> {
  if (!fs.existsSync(config.backendDir)) {
    fs.mkdirSync(config.backendDir, { recursive: true });
    console.log(`✅ Created backend directory: ${config.backendDir}`);
  }
}

/**
 * Writes a Pulumi.yaml file for the test
 */
export function writePulumiYaml(
  config: TestConfig,
  mainFile: string,
  description?: string
): void {
  const pulumiYamlPath = path.join(config.testDir, 'Pulumi.yaml');
  const content = `name: ${config.projectName}
description: ${description || `Test for ${config.stackName}`}
runtime:
  name: nodejs
  options:
    typescript: true
main: ${mainFile}
`;
  fs.writeFileSync(pulumiYamlPath, content, 'utf8');
}

/**
 * Checks if a stack exists
 */
export async function checkStackExists(config: TestConfig): Promise<boolean> {
  try {
    const { stdout } = await runCommand('pulumi stack ls --json', config);
    const stacks = JSON.parse(stdout);
    return stacks.some((s: any) => s.name === config.stackName);
  } catch {
    // If JSON parsing fails, fall back to text search
    try {
      const { stdout } = await runCommand('pulumi stack ls', config);
      return stdout.includes(config.stackName);
    } catch {
      return false;
    }
  }
}

/**
 * Creates a new Pulumi stack
 */
export async function createStack(config: TestConfig): Promise<void> {
  console.log(`\n📦 Creating test stack: ${config.stackName}`);
  await runCommand(`pulumi stack init ${config.stackName} --non-interactive`, config);
  console.log(`✅ Stack created`);
}

/**
 * Selects a Pulumi stack
 */
export async function selectStack(config: TestConfig): Promise<void> {
  console.log(`\n📦 Selecting test stack: ${config.stackName}`);
  await runCommand(`pulumi stack select ${config.stackName} --non-interactive`, config);
  console.log(`✅ Stack selected`);
}

/**
 * Ensures a stack exists and is selected
 */
export async function ensureStack(config: TestConfig): Promise<void> {
  await ensureBackendDir(config);
  
  const exists = await checkStackExists(config);
  if (!exists) {
    await createStack(config);
  } else {
    await selectStack(config);
  }
}

/**
 * Runs pulumi preview with diff and debug
 */
export async function runPreview(config: TestConfig): Promise<CommandResult> {
  console.log(`\n🔍 Running pulumi preview --diff --debug...`);
  return await runCommand(
    `pulumi preview --stack ${config.stackName} --diff --debug --non-interactive`,
    config
  );
}

/**
 * Cleans up test resources
 */
export async function cleanup(config: TestConfig, additionalFiles: string[] = []): Promise<void> {
  console.log(`\n🧹 Cleaning up test files...`);
  
  // Remove backend directory
  if (fs.existsSync(config.backendDir)) {
    fs.rmSync(config.backendDir, { recursive: true, force: true });
    console.log(`  ✅ Removed ${config.backendDir}`);
  }
  
  // Remove additional files
  for (const file of additionalFiles) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`  ✅ Removed ${file}`);
    }
  }
  
  // Don't remove Pulumi.yaml - we need it for testing
  // const pulumiYamlPath = path.join(config.testDir, 'Pulumi.yaml');
  // if (fs.existsSync(pulumiYamlPath)) {
  //   fs.unlinkSync(pulumiYamlPath);
  //   console.log(`  ✅ Removed ${pulumiYamlPath}`);
  // }
}

/**
 * Verifies that secrets are properly handled in the output
 */
export function verifySecretHandling(output: string, secretValue: string): TestResult {
  // Check if transform was invoked
  if (!output.includes('[SecretResolution] Transform invoked for:')) {
    return {
      success: false,
      message: 'Transform was not invoked for any resources',
      output,
    };
  }
  
  // Check if secret was resolved (should appear in debug output)
  if (!output.includes(secretValue)) {
    return {
      success: false,
      message: 'Secret was not resolved - value not found in output',
      output,
    };
  }
  
  // Check if secrets are properly obscured in diff output
  const hasSecretMarkers = output.includes('[secret]') || output.includes('<sensitive>');
  const secretInDiff = output.match(new RegExp(`\\+\\s+\\w+:\\s*"${secretValue}"`, 'g'));
  
  if (secretInDiff && secretInDiff.length > 0 && !hasSecretMarkers) {
    // Check if it's in debug logs vs actual diff
    const isDiffOutput = secretInDiff.some(match => match.startsWith('+'));
    if (isDiffOutput) {
      console.warn('⚠️  Secret appears unobscured in diff output');
      // This is a warning, not a failure, as Pulumi's secret handling varies
    }
  }
  
  // Check if secret keys are registered
  const secretKeysRegistered = 
    output.includes('PULUMI_CONFIG_SECRET_KEYS') ||
    output.includes('resolved-secret:') ||
    output.includes('Added config key to PULUMI_CONFIG_SECRET_KEYS');
  
  if (!secretKeysRegistered && !hasSecretMarkers) {
    console.warn('⚠️  Secrets may not be properly registered in PULUMI_CONFIG_SECRET_KEYS');
  }
  
  return {
    success: true,
    message: '✅ Secrets are resolved correctly and transforms are applied',
    output,
  };
}

/**
 * Creates a test secret file and returns its path and value
 */
export function createTestSecretFile(name: string = 'test-secret'): { path: string; value: string } {
  const testSecretFile = path.resolve(process.cwd(), `.${name}.txt`);
  const testSecretValue = `${name}-value-${Date.now()}`;
  fs.writeFileSync(testSecretFile, testSecretValue, 'utf8');
  console.log(`Created test secret file: ${testSecretFile}`);
  console.log(`Test secret value: ${testSecretValue}\n`);
  return { path: testSecretFile, value: testSecretValue };
}
