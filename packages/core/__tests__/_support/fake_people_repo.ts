/**
 * Re-export of the shared in-memory `PeopleRepository` fake. The
 * implementation lives in `@dina/test-harness` so both `@dina/core`
 * and `@dina/brain` test suites share one faithful stand-in (the
 * contact directory now resolves did→person through the people graph,
 * so any `addContact`/`getContact` test needs a wired people repo).
 */

export { makeFakePeopleRepo } from '@dina/test-harness';
