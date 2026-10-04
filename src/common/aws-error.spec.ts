/**
 * Unit suite for canonical AWS SDK error narrowing.
 *
 * - matches by `name` or `code` since SDK faults vary by path
 * - rejects non-objects, null, and mismatched exception names.
 */
import { describe, it, expect } from 'vitest';
import { isAwsError } from './aws-error';

describe('isAwsError', () => {
  it('matches by name or code', () => {
    expect(
      isAwsError(
        { name: 'ConditionalCheckFailedException' },
        'ConditionalCheckFailedException',
      ),
    ).toBe(true);
    expect(
      isAwsError(
        { code: 'ResourceNotFoundException' },
        'ResourceNotFoundException',
      ),
    ).toBe(true);
  });

  it('rejects mismatched names, non-objects, and null', () => {
    expect(
      isAwsError({ name: 'OtherException' }, 'ConditionalCheckFailedException'),
    ).toBe(false);
    expect(isAwsError(null, 'ConditionalCheckFailedException')).toBe(false);
    expect(isAwsError(undefined, 'ConditionalCheckFailedException')).toBe(
      false,
    );
    expect(
      isAwsError(
        'ConditionalCheckFailedException',
        'ConditionalCheckFailedException',
      ),
    ).toBe(false);
  });
});
