import {
  InMemoryReviewPublishRepository,
  type ClassifiedError,
  type ReviewRecordWriter,
} from '@dina/core';
import { pino } from 'pino';

import { ReviewPublishSupervisor } from '../src/peerlens/review_publish_supervisor';

const OWNER = 'did:plc:owner';
const recordJSON = JSON.stringify({
  subject: { type: 'product', identifier: 'chair-123' },
  category: 'furniture',
  sentiment: 'positive',
  createdAt: '2026-07-25T10:00:00.000Z',
  isAgentGenerated: true,
});

function createJob(repo: InMemoryReviewPublishRepository, id: string): void {
  repo.create({
    jobId: id,
    ownerDid: OWNER,
    rkey: id,
    recordJSON,
    draftJSON: '{}',
    createdAt: 1,
  });
}

const permanent = (error: unknown): ClassifiedError => ({
  class: 'permanent',
  code: 'bad_request',
  message: error instanceof Error ? error.message : String(error),
});

describe('ReviewPublishSupervisor', () => {
  it('single-flights overlapping ticks and publishes each queued row once', async () => {
    const repo = new InMemoryReviewPublishRepository();
    createJob(repo, 'job-1');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = jest.fn(async () => {
      await gate;
      return { uri: 'at://review/1', cid: 'bafy1' };
    }) as ReviewRecordWriter;
    const supervisor = new ReviewPublishSupervisor({
      ownerDid: OWNER,
      repo,
      publish,
      classifyError: permanent,
      logger: pino({ level: 'silent' }),
      now: () => 100,
    });

    const first = supervisor.tick();
    const second = supervisor.tick();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);

    expect(repo.getById('job-1')).toMatchObject({ status: 'published' });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('records permanent failures without throwing out of the supervisor', async () => {
    const repo = new InMemoryReviewPublishRepository();
    createJob(repo, 'job-2');
    const supervisor = new ReviewPublishSupervisor({
      ownerDid: OWNER,
      repo,
      publish: async () => {
        throw new Error('invalid');
      },
      classifyError: permanent,
      logger: pino({ level: 'silent' }),
      now: () => 100,
    });

    await expect(supervisor.tick()).resolves.toBeUndefined();
    expect(repo.getById('job-2')).toMatchObject({
      status: 'failed',
      lastErrorCode: 'bad_request',
    });
  });
});
