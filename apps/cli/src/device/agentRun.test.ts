import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { spawnHeteroAgentRun } from './agentRun';

const { fallbackFinishMock, removeTaskMock, saveTaskMock, spawnMock } = vi.hoisted(() => ({
  fallbackFinishMock: vi.fn().mockResolvedValue({ ack: true }),
  removeTaskMock: vi.fn(),
  saveTaskMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../api/client', () => ({
  createLambdaClient: vi.fn(() => ({
    aiAgent: { heteroFinish: { mutate: fallbackFinishMock } },
  })),
}));
vi.mock('../daemon/taskRegistry', () => ({
  removeTask: removeTaskMock,
  saveTask: saveTaskMock,
}));

const makeFakeChild = () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
  };
  child.pid = 1234;
  child.stdin = { end: vi.fn(), write: vi.fn() };
  return child;
};

const baseParams = {
  agentType: 'claudeCode',
  jwt: 'jwt',
  operationId: 'op',
  prompt: 'hi',
  serverUrl: 'https://app.lobehub.com',
  topicId: 'tpc',
};

describe('spawnHeteroAgentRun', () => {
  afterEach(() => {
    spawnMock.mockReset();
    fallbackFinishMock.mockClear();
    removeTaskMock.mockClear();
    saveTaskMock.mockClear();
  });

  it('spawns `lh hetero exec` in server-ingest mode via the current CLI entry', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const ackPromise = spawnHeteroAgentRun({
      ...baseParams,
      cwd: '/work/dir',
      jwt: 'jwt-token',
      operationId: 'op-1',
      topicId: 'tpc-1',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0];

    expect(bin).toBe(process.execPath);
    expect(args).toEqual([
      ...process.execArgv,
      process.argv[1],
      'hetero',
      'exec',
      '--type',
      'claudeCode',
      '--operation-id',
      'op-1',
      '--topic',
      'tpc-1',
      '--render',
      'none',
      '--input-json',
      '-',
      '--cwd',
      '/work/dir',
    ]);
    expect(opts).toMatchObject({
      cwd: '/work/dir',
      detached: process.platform !== 'win32',
      env: expect.objectContaining({
        LOBEHUB_JWT: 'jwt-token',
        LOBEHUB_SERVER: 'https://app.lobehub.com',
      }),
    });

    // stdin is only written after the child actually spawns.
    expect(child.stdin.write).not.toHaveBeenCalled();
    child.emit('spawn');

    await expect(ackPromise).resolves.toEqual({ status: 'accepted' });
    expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify('hi'));
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(saveTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent-run', pid: 1234, taskId: 'op-1' }),
    );
  });

  it('removes the task entry and reports a terminal fallback after an accepted child exits abnormally', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const ackPromise = spawnHeteroAgentRun({
      ...baseParams,
      agentType: 'opencode',
      operationId: 'op-exit',
    });
    child.emit('spawn');
    await ackPromise;
    child.emit('exit', 2, null);
    await vi.waitFor(() => expect(fallbackFinishMock).toHaveBeenCalledTimes(1));

    expect(removeTaskMock).toHaveBeenCalledWith('op-exit');
    expect(fallbackFinishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'op-exit',
        result: 'error',
        topicId: 'tpc',
      }),
    );
  });

  it('does not report a fallback after a clean exit with an acknowledged terminal handshake', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const ackPromise = spawnHeteroAgentRun({
      ...baseParams,
      agentType: 'opencode',
      operationId: 'op-clean-exit',
    });
    child.emit('spawn');
    await ackPromise;
    child.emit('exit', 0, null);
    await Promise.resolve();

    expect(removeTaskMock).toHaveBeenCalledWith('op-clean-exit');
    expect(fallbackFinishMock).not.toHaveBeenCalled();
  });

  it('rejects (no stuck run) when the child errors before spawning, e.g. bad cwd', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const ackPromise = spawnHeteroAgentRun({ ...baseParams, cwd: '/missing' });
    child.emit('error', new Error('spawn ENOENT'));

    await expect(ackPromise).resolves.toEqual({ reason: 'spawn ENOENT', status: 'rejected' });
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it('appends --resume when resuming a session', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    void spawnHeteroAgentRun({ ...baseParams, resumeSessionId: 'sess-9' });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--resume');
    expect(args).toContain('sess-9');
  });

  it('forwards resolved args to lh hetero exec', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    void spawnHeteroAgentRun({
      ...baseParams,
      args: ['--model', 'opus', '--effort', 'high'],
    });

    const [, args] = spawnMock.mock.calls[0];
    expect(args.slice(-4)).toEqual(['--model', 'opus', '--effort', 'high']);
  });

  it('sends a content-block array to stdin when systemContext is provided', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const ackPromise = spawnHeteroAgentRun({
      ...baseParams,
      prompt: 'do it',
      systemContext: 'workspace rules',
    });
    child.emit('spawn');
    await ackPromise;

    expect(child.stdin.write).toHaveBeenCalledWith(
      JSON.stringify([
        { text: 'workspace rules', type: 'text' },
        { text: 'do it', type: 'text' },
      ]),
    );
  });

  it('appends image blocks to stdin when imageList is provided', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const ackPromise = spawnHeteroAgentRun({
      ...baseParams,
      imageList: [{ id: 'file-1', url: 'https://signed/a.png' }],
      prompt: 'look at this',
    });
    child.emit('spawn');
    await ackPromise;

    expect(child.stdin.write).toHaveBeenCalledWith(
      JSON.stringify([
        { text: 'look at this', type: 'text' },
        { source: { id: 'file-1', type: 'url', url: 'https://signed/a.png' }, type: 'image' },
      ]),
    );
  });
});
