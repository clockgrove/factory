export const shippedPluginEntries: readonly string[];
export function assertNoPackagedWorkflows(paths: Iterable<string>, subject?: string): void;
export function packagedPaths(root: string): string[];
export function pluginArchiveArguments(commit: string, output?: string): string[];
export function pluginTreeArguments(commit: string): string[];
export function stagePluginPackage(sourceRoot: string, stagedRoot: string): string[];
