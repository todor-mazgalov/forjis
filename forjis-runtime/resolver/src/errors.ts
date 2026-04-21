/**
 * Error classes for the @forjis/resolver package.
 *
 * Provides a structured error hierarchy rooted at ResolverError, with specific
 * subclasses for each failure domain: build file parsing, plugin resolution,
 * and plugin dependency verification.
 */

/** Base error class for all resolver-specific errors. */
export class ResolverError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'ResolverError';
  }
}

/** Thrown when the specified build file does not exist on disk. */
export class BuildFileNotFoundError extends ResolverError {
  constructor(public readonly filePath: string) {
    super(`Build file not found: ${filePath}\nRun "forjis init" to create one.`);
    this.name = 'BuildFileNotFoundError';
  }
}

/** Thrown when the build file fails schema validation. Carries all error messages. */
export class BuildFileValidationError extends ResolverError {
  constructor(public readonly errors: string[]) {
    super(`Build file validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'BuildFileValidationError';
  }
}

/** Thrown when a referenced plugin is not found in any resolved repository. */
export class PluginNotFoundError extends ResolverError {
  constructor(public readonly pluginName: string) {
    super(`Plugin "${pluginName}" not found in any repository`);
    this.name = 'PluginNotFoundError';
  }
}

/** Thrown when a plugin file fails schema validation. */
export class PluginValidationError extends ResolverError {
  constructor(public readonly pluginName: string, public readonly details: string) {
    super(`Invalid plugin "${pluginName}": ${details}`);
    this.name = 'PluginValidationError';
  }
}

/** Thrown when a plugin requires resources that are not available in the registry. */
export class PluginDependencyError extends ResolverError {
  constructor(
    public readonly pluginName: string,
    public readonly missingResources: string[]
  ) {
    super(
      `Plugin "${pluginName}" requires unavailable resources: ${missingResources.join(', ')}`
    );
    this.name = 'PluginDependencyError';
  }
}
