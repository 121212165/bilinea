import { describe, expect, it } from 'vitest';
import { API_VERSION } from '../../src/shared/constants';

describe('冒烟测试（T-001）', () => {
  it('常量可导入、版本号格式正确', () => {
    expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
