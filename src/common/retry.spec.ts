/**
 * Test suite for the shared bounded-retry helper.
 *
 * - resolves without retry on first success, retries then resolves
 * - exhausts the budget and rethrows the last error
 * - honours custom budgets, reports failures, falls back when the error is not an `Error`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { withBoundedRetry } from './retry';

afterEach(() => {
  vi.useRealTimers();
});

describe('withBoundedRetry', () => {
  it('resolves with the task result without retry', async () => {
    const task = vi.fn<() => Promise<string>>().mockResolvedValue('ok');

    await expect(withBoundedRetry(task)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('retries failed attempts then resolves', async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce('ok');

    const pending = withBoundedRetry(task);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error after exhausting retries', async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const pending = withBoundedRetry(task);
    const assertion = expect(pending).rejects.toThrow('ECONNREFUSED');
    await vi.runAllTimersAsync();
    await assertion;
    expect(task).toHaveBeenCalledTimes(10);
  });

  it('honours a custom attempt budget', async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('down'));

    const pending = withBoundedRetry(task, { attempts: 3 });
    const assertion = expect(pending).rejects.toThrow('down');
    await vi.runAllTimersAsync();
    await assertion;
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('reports each failed attempt before sleeping', async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockResolvedValueOnce('ok');
    const onAttemptFailed =
      vi.fn<(attempt: number, attempts: number, err: unknown) => void>();

    const pending = withBoundedRetry(task, { onAttemptFailed });
    await vi.runAllTimersAsync();
    await pending;
    expect(onAttemptFailed).toHaveBeenCalledTimes(2);
    expect(onAttemptFailed).toHaveBeenNthCalledWith(
      1,
      1,
      10,
      expect.any(Error),
    );
    expect(onAttemptFailed).toHaveBeenNthCalledWith(
      2,
      2,
      10,
      expect.any(Error),
    );
  });

  it('throws the fallback message when the last failure is not an Error', async () => {
    vi.useFakeTimers();
    const task = vi.fn<() => Promise<string>>().mockRejectedValue('boom');

    const pending = withBoundedRetry(task, {
      attempts: 2,
      failureMessage: 'custom failure',
    });
    const assertion = expect(pending).rejects.toThrow('custom failure');
    await vi.runAllTimersAsync();
    await assertion;
    expect(task).toHaveBeenCalledTimes(2);
  });
});
