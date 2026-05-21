import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/services/browserAutomation.js', () => ({
  default: {
    checkAuthentication: vi.fn(async () => true),
    createPage: vi.fn(async () => ({ close: vi.fn() })),
    getFollowers: vi.fn(async () => [{ username: 'follower' }]),
    getFollowing: vi.fn(async () => [
      { username: 'follower' },
      { username: 'not_following_back' },
    ]),
    navigateToTwitter: vi.fn(async () => {}),
    randomDelay: vi.fn(async () => {}),
    unfollowUser: vi.fn(async () => ({ success: true })),
  },
}));

import browserAutomation from '../api/services/browserAutomation.js';
import { unfollowEveryoneBrowser } from '../api/services/operations/puppeteer/unfollowEveryone.js';
import { unfollowNonFollowersBrowser } from '../api/services/operations/puppeteer/unfollowNonFollowers.js';

describe('unfollow dry-run processors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not unfollow non-followers during dry-run', async () => {
    const result = await unfollowNonFollowersBrowser('user_1', {
      dryRun: true,
      limit: 10,
      maxUsers: 100,
      sessionCookie: 'cookie',
      username: 'source',
    }, vi.fn());

    expect(browserAutomation.unfollowUser).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      candidates: ['not_following_back'],
      totalProcessed: 0,
    });
  });

  it('does not unfollow everyone during dry-run', async () => {
    const result = await unfollowEveryoneBrowser('user_1', {
      dryRun: true,
      limit: 1,
      maxUsers: 100,
      sessionCookie: 'cookie',
      username: 'source',
    }, vi.fn());

    expect(browserAutomation.unfollowUser).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      candidates: ['follower'],
      totalProcessed: 0,
    });
  });
});
