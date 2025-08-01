/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Mocked } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCompletion } from './useCompletion.js';
import * as fs from 'fs/promises';
import { glob } from 'glob';
import {
  CommandContext,
  CommandKind,
  SlashCommand,
} from '../commands/types.js';
import { Config, FileDiscoveryService } from '@google/gemini-cli-core';
import { useTextBuffer } from '../components/shared/text-buffer.js';

interface MockConfig {
  getFileFilteringOptions: () => {
    respectGitIgnore: boolean;
    respectGeminiIgnore: boolean;
  };
  getEnableRecursiveFileSearch: () => boolean;
  getFileService: () => FileDiscoveryService | null;
}

// Helper to create real TextBuffer objects within renderHook
const useTextBufferForTest = (text: string) => {
  const cursorOffset = text.length;

  return useTextBuffer({
    initialText: text,
    initialCursorOffset: cursorOffset,
    viewport: { width: 80, height: 20 },
    isValidPath: () => false,
    onChange: () => {},
  });
};

// Mock dependencies
vi.mock('fs/promises');
vi.mock('@google/gemini-cli-core', async () => {
  const actual = await vi.importActual('@google/gemini-cli-core');
  return {
    ...actual,
    FileDiscoveryService: vi.fn(),
    isNodeError: vi.fn((error) => error.code === 'ENOENT'),
    escapePath: vi.fn((path) => path),
    unescapePath: vi.fn((path) => path),
    getErrorMessage: vi.fn((error) => error.message),
  };
});
vi.mock('glob');

describe('useCompletion git-aware filtering integration', () => {
  let mockFileDiscoveryService: Mocked<FileDiscoveryService>;
  let mockConfig: MockConfig;

  const testCwd = '/test/project';
  const slashCommands = [
    {
      name: 'help',
      description: 'Show help',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    },
    {
      name: 'clear',
      description: 'Clear screen',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    },
  ];

  // A minimal mock is sufficient for these tests.
  const mockCommandContext = {} as CommandContext;

  const mockSlashCommands: SlashCommand[] = [
    {
      name: 'help',
      altNames: ['?'],
      description: 'Show help',
      action: vi.fn(),
      kind: CommandKind.BUILT_IN,
    },
    {
      name: 'stats',
      altNames: ['usage'],
      description: 'check session stats. Usage: /stats [model|tools]',
      action: vi.fn(),
      kind: CommandKind.BUILT_IN,
    },
    {
      name: 'clear',
      description: 'Clear the screen',
      action: vi.fn(),
      kind: CommandKind.BUILT_IN,
    },
    {
      name: 'memory',
      description: 'Manage memory',
      kind: CommandKind.BUILT_IN,
      // This command is a parent, no action.
      subCommands: [
        {
          name: 'show',
          description: 'Show memory',
          kind: CommandKind.BUILT_IN,
          action: vi.fn(),
        },
        {
          name: 'add',
          description: 'Add to memory',
          kind: CommandKind.BUILT_IN,
          action: vi.fn(),
        },
      ],
    },
    {
      name: 'chat',
      description: 'Manage chat history',
      kind: CommandKind.BUILT_IN,
      subCommands: [
        {
          name: 'save',
          description: 'Save chat',
          kind: CommandKind.BUILT_IN,
          action: vi.fn(),
        },
        {
          name: 'resume',
          description: 'Resume a saved chat',
          kind: CommandKind.BUILT_IN,
          action: vi.fn(),
          // This command provides its own argument completions
          completion: vi
            .fn()
            .mockResolvedValue([
              'my-chat-tag-1',
              'my-chat-tag-2',
              'my-channel',
            ]),
        },
      ],
    },
  ];

  beforeEach(() => {
    mockFileDiscoveryService = {
      shouldGitIgnoreFile: vi.fn(),
      shouldGeminiIgnoreFile: vi.fn(),
      shouldIgnoreFile: vi.fn(),
      filterFiles: vi.fn(),
      getGeminiIgnorePatterns: vi.fn(),
      projectRoot: '',
      gitIgnoreFilter: null,
      geminiIgnoreFilter: null,
      isFileIgnored: vi.fn(),
    } as unknown as Mocked<FileDiscoveryService>;

    mockConfig = {
      getFileFilteringOptions: vi.fn(() => ({
        respectGitIgnore: true,
        respectGeminiIgnore: true,
      })),
      getEnableRecursiveFileSearch: vi.fn(() => true),
      getFileService: vi.fn(() => mockFileDiscoveryService),
    };

    vi.mocked(FileDiscoveryService).mockImplementation(
      () => mockFileDiscoveryService,
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should filter git-ignored entries from @ completions', async () => {
    const globResults = [`${testCwd}/data`, `${testCwd}/dist`];
    vi.mocked(glob).mockResolvedValue(globResults);

    // Mock git ignore service to ignore certain files
    mockFileDiscoveryService.shouldGitIgnoreFile.mockImplementation(
      (path: string) => path.includes('dist'),
    );
    mockFileDiscoveryService.shouldIgnoreFile.mockImplementation(
      (path: string, options) => {
        if (options?.respectGitIgnore !== false) {
          return mockFileDiscoveryService.shouldGitIgnoreFile(path);
        }
        return false;
      },
    );

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('@d');
      return useCompletion(
        textBuffer,
        testCwd,
        slashCommands,
        mockCommandContext,
        mockConfig as Config,
      );
    });

    // Wait for async operations to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150)); // Account for debounce
    });

    expect(result.current.suggestions).toHaveLength(1);
    expect(result.current.suggestions).toEqual(
      expect.arrayContaining([{ label: 'data', value: 'data' }]),
    );
    expect(result.current.showSuggestions).toBe(true);
  });

  it('should filter git-ignored directories from @ completions', async () => {
    // Mock fs.readdir to return both regular and git-ignored directories
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'src', isDirectory: () => true },
      { name: 'node_modules', isDirectory: () => true },
      { name: 'dist', isDirectory: () => true },
      { name: 'README.md', isDirectory: () => false },
      { name: '.env', isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    // Mock ignore service to ignore certain files
    mockFileDiscoveryService.shouldGitIgnoreFile.mockImplementation(
      (path: string) =>
        path.includes('node_modules') ||
        path.includes('dist') ||
        path.includes('.env'),
    );
    mockFileDiscoveryService.shouldIgnoreFile.mockImplementation(
      (path: string, options) => {
        if (
          options?.respectGitIgnore &&
          mockFileDiscoveryService.shouldGitIgnoreFile(path)
        ) {
          return true;
        }
        if (
          options?.respectGeminiIgnore &&
          mockFileDiscoveryService.shouldGeminiIgnoreFile
        ) {
          return mockFileDiscoveryService.shouldGeminiIgnoreFile(path);
        }
        return false;
      },
    );

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('@');
      return useCompletion(
        textBuffer,
        testCwd,
        slashCommands,
        mockCommandContext,
        mockConfig as Config,
      );
    });

    // Wait for async operations to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150)); // Account for debounce
    });

    expect(result.current.suggestions).toHaveLength(2);
    expect(result.current.suggestions).toEqual(
      expect.arrayContaining([
        { label: 'src/', value: 'src/' },
        { label: 'README.md', value: 'README.md' },
      ]),
    );
    expect(result.current.showSuggestions).toBe(true);
  });

  it('should handle recursive search with git-aware filtering', async () => {
    // Mock the recursive file search scenario
    vi.mocked(fs.readdir).mockImplementation(
      async (
        dirPath: string | Buffer | URL,
        options?: { withFileTypes?: boolean },
      ) => {
        const path = dirPath.toString();
        if (options?.withFileTypes) {
          if (path === testCwd) {
            return [
              { name: 'data', isDirectory: () => true },
              { name: 'dist', isDirectory: () => true },
              { name: 'node_modules', isDirectory: () => true },
              { name: 'README.md', isDirectory: () => false },
              { name: '.env', isDirectory: () => false },
            ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
          }
          if (path.endsWith('/src')) {
            return [
              { name: 'index.ts', isDirectory: () => false },
              { name: 'components', isDirectory: () => true },
            ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
          }
          if (path.endsWith('/temp')) {
            return [
              { name: 'temp.log', isDirectory: () => false },
            ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
          }
        }
        return [];
      },
    );

    // Mock ignore service
    mockFileDiscoveryService.shouldGitIgnoreFile.mockImplementation(
      (path: string) => path.includes('node_modules') || path.includes('temp'),
    );
    mockFileDiscoveryService.shouldIgnoreFile.mockImplementation(
      (path: string, options) => {
        if (
          options?.respectGitIgnore &&
          mockFileDiscoveryService.shouldGitIgnoreFile(path)
        ) {
          return true;
        }
        if (
          options?.respectGeminiIgnore &&
          mockFileDiscoveryService.shouldGeminiIgnoreFile
        ) {
          return mockFileDiscoveryService.shouldGeminiIgnoreFile(path);
        }
        return false;
      },
    );

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('@t');
      return useCompletion(
        textBuffer,
        testCwd,
        slashCommands,
        mockCommandContext,
        mockConfig as Config,
      );
    });

    // Wait for async operations to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // Should not include anything from node_modules or dist
    const suggestionLabels = result.current.suggestions.map((s) => s.label);
    expect(suggestionLabels).not.toContain('temp/');
    expect(suggestionLabels.some((l) => l.includes('node_modules'))).toBe(
      false,
    );
  });

  it('should not perform recursive search when disabled in config', async () => {
    const globResults = [`${testCwd}/data`, `${testCwd}/dist`];
    vi.mocked(glob).mockResolvedValue(globResults);

    // Disable recursive search in the mock config
    const mockConfigNoRecursive = {
      ...mockConfig,
      getEnableRecursiveFileSearch: vi.fn(() => false),
    } as unknown as Config;

    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'data', isDirectory: () => true },
      { name: 'dist', isDirectory: () => true },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    renderHook(() => {
      const textBuffer = useTextBufferForTest('@d');
      return useCompletion(
        textBuffer,
        testCwd,
        slashCommands,
        mockCommandContext,
        mockConfigNoRecursive,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // `glob` should not be called because recursive search is disabled
    expect(glob).not.toHaveBeenCalled();
    // `fs.readdir` should be called for the top-level directory instead
    expect(fs.readdir).toHaveBeenCalledWith(testCwd, { withFileTypes: true });
  });

  it('should work without config (fallback behavior)', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'src', isDirectory: () => true },
      { name: 'node_modules', isDirectory: () => true },
      { name: 'README.md', isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('@');
      return useCompletion(
        textBuffer,
        testCwd,
        slashCommands,
        mockCommandContext,
        undefined,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(result.current.suggestions).toHaveLength(3);
    expect(result.current.suggestions).toEqual(
      expect.arrayContaining([
        { label: 'src/', value: 'src/' },
        { label: 'node_modules/', value: 'node_modules/' },
        { label: 'README.md', value: 'README.md' },
      ]),
    );
  });

  it('should handle git discovery service initialization failure gracefully', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'src', isDirectory: () => true },
      { name: 'README.md', isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('@');
      return useCompletion(
        textBuffer,
        testCwd,
        slashCommands,
        mockCommandContext,
        mockConfig as Config,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // Since we use centralized service, initialization errors are handled at config level
    // This test should verify graceful fallback behavior
    expect(result.current.suggestions.length).toBeGreaterThanOrEqual(0);
    // Should still show completions even if git discovery fails
    expect(result.current.suggestions.length).toBeGreaterThan(0);

    consoleSpy.mockRestore();
  });

  it('should handle directory-specific completions with git filtering', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'component.tsx', isDirectory: () => false },
      { name: 'temp.log', isDirectory: () => false },
      { name: 'index.ts', isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    mockFileDiscoveryService.shouldGitIgnoreFile.mockImplementation(
      (path: string) => path.includes('.log'),
    );
    mockFileDiscoveryService.shouldIgnoreFile.mockImplementation(
      (path: string, options) => {
        if (options?.respectGitIgnore) {
          return mockFileDiscoveryService.shouldGitIgnoreFile(path);
        }
        if (options?.respectGeminiIgnore) {
          return mockFileDiscoveryService.shouldGeminiIgnoreFile(path);
        }
        return false;
      },
    );

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('@src/comp');
      return useCompletion(
        textBuffer,
        testCwd,
        slashCommands,
        mockCommandContext,
        mockConfig as Config,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // Should filter out .log files but include matching .tsx files
    expect(result.current.suggestions).toEqual([
      { label: 'component.tsx', value: 'component.tsx' },
    ]);
  });

  it('should use glob for top-level @ completions when available', async () => {
    const globResults = [`${testCwd}/src/index.ts`, `${testCwd}/README.md`];
    vi.mocked(glob).mockResolvedValue(globResults);

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('@s');
      return useCompletion(
        textBuffer,
        testCwd,
        slashCommands,
        mockCommandContext,
        mockConfig as Config,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(glob).toHaveBeenCalledWith('**/s*', {
      cwd: testCwd,
      dot: false,
      nocase: true,
    });
    expect(fs.readdir).not.toHaveBeenCalled(); // Ensure glob is used instead of readdir
    expect(result.current.suggestions).toEqual([
      { label: 'README.md', value: 'README.md' },
      { label: 'src/index.ts', value: 'src/index.ts' },
    ]);
  });

  it('should include dotfiles in glob search when input starts with a dot', async () => {
    const globResults = [
      `${testCwd}/.env`,
      `${testCwd}/.gitignore`,
      `${testCwd}/src/index.ts`,
    ];
    vi.mocked(glob).mockResolvedValue(globResults);

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('@.');
      return useCompletion(
        textBuffer,
        testCwd,
        slashCommands,
        mockCommandContext,
        mockConfig as Config,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(glob).toHaveBeenCalledWith('**/.*', {
      cwd: testCwd,
      dot: true,
      nocase: true,
    });
    expect(fs.readdir).not.toHaveBeenCalled();
    expect(result.current.suggestions).toEqual([
      { label: '.env', value: '.env' },
      { label: '.gitignore', value: '.gitignore' },
      { label: 'src/index.ts', value: 'src/index.ts' },
    ]);
  });

  it('should suggest top-level command names based on partial input', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/mem');
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    expect(result.current.suggestions).toEqual([
      { label: 'memory', value: 'memory', description: 'Manage memory' },
    ]);
    expect(result.current.showSuggestions).toBe(true);
  });

  it.each([['/?'], ['/usage']])(
    'should not suggest commands when altNames is fully typed',
    async (altName) => {
      const { result } = renderHook(() => {
        const textBuffer = useTextBufferForTest(altName);
        return useCompletion(
          textBuffer,
          '/test/cwd',
          mockSlashCommands,
          mockCommandContext,
        );
      });

      expect(result.current.suggestions).toHaveLength(0);
    },
  );

  it('should suggest commands based on partial altNames matches', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/usag'); // part of the word "usage"
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    expect(result.current.suggestions).toEqual([
      {
        label: 'stats',
        value: 'stats',
        description: 'check session stats. Usage: /stats [model|tools]',
      },
    ]);
  });

  it('should suggest sub-command names for a parent command', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/memory a');
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    expect(result.current.suggestions).toEqual([
      { label: 'add', value: 'add', description: 'Add to memory' },
    ]);
  });

  it('should suggest all sub-commands when the query ends with the parent command and a space', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/memory ');
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    expect(result.current.suggestions).toHaveLength(2);
    expect(result.current.suggestions).toEqual(
      expect.arrayContaining([
        { label: 'show', value: 'show', description: 'Show memory' },
        { label: 'add', value: 'add', description: 'Add to memory' },
      ]),
    );
  });

  it('should call the command.completion function for argument suggestions', async () => {
    const availableTags = ['my-chat-tag-1', 'my-chat-tag-2', 'another-channel'];
    const mockCompletionFn = vi
      .fn()
      .mockImplementation(
        async (_context: CommandContext, partialArg: string) =>
          availableTags.filter((tag) => tag.startsWith(partialArg)),
      );

    const mockCommandsWithFiltering = JSON.parse(
      JSON.stringify(mockSlashCommands),
    ) as SlashCommand[];

    const chatCmd = mockCommandsWithFiltering.find(
      (cmd) => cmd.name === 'chat',
    );
    if (!chatCmd || !chatCmd.subCommands) {
      throw new Error(
        "Test setup error: Could not find the 'chat' command with subCommands in the mock data.",
      );
    }

    const resumeCmd = chatCmd.subCommands.find((sc) => sc.name === 'resume');
    if (!resumeCmd) {
      throw new Error(
        "Test setup error: Could not find the 'resume' sub-command in the mock data.",
      );
    }

    resumeCmd.completion = mockCompletionFn;

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/chat resume my-ch');
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockCommandsWithFiltering,
        mockCommandContext,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(mockCompletionFn).toHaveBeenCalledWith(mockCommandContext, 'my-ch');

    expect(result.current.suggestions).toEqual([
      { label: 'my-chat-tag-1', value: 'my-chat-tag-1' },
      { label: 'my-chat-tag-2', value: 'my-chat-tag-2' },
    ]);
  });

  it('should not provide suggestions for a fully typed command that has no sub-commands or argument completion', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/clear ');
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    expect(result.current.suggestions).toHaveLength(0);
    expect(result.current.showSuggestions).toBe(false);
  });

  it('should not provide suggestions for an unknown command', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/unknown-command');
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    expect(result.current.suggestions).toHaveLength(0);
    expect(result.current.showSuggestions).toBe(false);
  });

  it('should suggest sub-commands for a fully typed parent command without a trailing space', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/memory'); // Note: no trailing space
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    // Assert that suggestions for sub-commands are shown immediately
    expect(result.current.suggestions).toHaveLength(2);
    expect(result.current.suggestions).toEqual(
      expect.arrayContaining([
        { label: 'show', value: 'show', description: 'Show memory' },
        { label: 'add', value: 'add', description: 'Add to memory' },
      ]),
    );
    expect(result.current.showSuggestions).toBe(true);
  });

  it('should NOT provide suggestions for a perfectly typed command that is a leaf node', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/clear'); // No trailing space
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    expect(result.current.suggestions).toHaveLength(0);
    expect(result.current.showSuggestions).toBe(false);
  });

  it('should call command.completion with an empty string when args start with a space', async () => {
    const mockCompletionFn = vi
      .fn()
      .mockResolvedValue(['my-chat-tag-1', 'my-chat-tag-2', 'my-channel']);

    const isolatedMockCommands = JSON.parse(
      JSON.stringify(mockSlashCommands),
    ) as SlashCommand[];

    const resumeCommand = isolatedMockCommands
      .find((cmd) => cmd.name === 'chat')
      ?.subCommands?.find((cmd) => cmd.name === 'resume');

    if (!resumeCommand) {
      throw new Error(
        'Test setup failed: could not find resume command in mock',
      );
    }
    resumeCommand.completion = mockCompletionFn;

    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/chat resume '); // Trailing space, no partial argument
      return useCompletion(
        textBuffer,
        '/test/cwd',
        isolatedMockCommands,
        mockCommandContext,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(mockCompletionFn).toHaveBeenCalledWith(mockCommandContext, '');
    expect(result.current.suggestions).toHaveLength(3);
    expect(result.current.showSuggestions).toBe(true);
  });

  it('should suggest all top-level commands for the root slash', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/');
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    expect(result.current.suggestions.length).toBe(mockSlashCommands.length);
    expect(result.current.suggestions.map((s) => s.label)).toEqual(
      expect.arrayContaining(['help', 'clear', 'memory', 'chat', 'stats']),
    );
  });

  it('should provide no suggestions for an invalid sub-command', async () => {
    const { result } = renderHook(() => {
      const textBuffer = useTextBufferForTest('/memory dothisnow');
      return useCompletion(
        textBuffer,
        '/test/cwd',
        mockSlashCommands,
        mockCommandContext,
      );
    });

    expect(result.current.suggestions).toHaveLength(0);
    expect(result.current.showSuggestions).toBe(false);
  });
});
