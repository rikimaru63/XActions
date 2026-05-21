import { describe, expect, it } from 'vitest';
import {
  createPollBrowser,
  postThreadBrowser,
  postTweetBrowser,
} from '../api/services/operations/puppeteer/posting.js';

describe('posting dry-run processors', () => {
  it('returns a post preview without opening a browser', async () => {
    const result = await postTweetBrowser('user_1', {
      dryRun: true,
      text: '投稿本文',
    });

    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      textPreview: '投稿本文',
      textLength: 4,
    });
  });

  it('returns thread previews without posting', async () => {
    const result = await postThreadBrowser('user_1', {
      dryRun: true,
      tweets: ['1つ目', '2つ目'],
    });

    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      tweetCount: 2,
    });
    expect(result.tweets.map((tweet) => tweet.textPreview)).toEqual(['1つ目', '2つ目']);
  });

  it('returns poll previews without posting', async () => {
    const result = await createPollBrowser('user_1', {
      dryRun: true,
      question: 'どちらですか？',
      options: ['A', 'B'],
      durationMinutes: 60,
    });

    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      questionPreview: 'どちらですか？',
      optionCount: 2,
      options: ['A', 'B'],
      durationMinutes: 60,
    });
  });
});
