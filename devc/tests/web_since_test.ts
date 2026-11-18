import { assertEquals } from 'jsr:@std/assert';
import {
  latestSince,
  sinceOptions,
  sinceStat,
} from '../web/static/lib/since.js';
import { diffTexts } from '../web/static/lib/diff.js';

const sha = (c: string) => c.repeat(40);
const HEAD = sha('f');
const mark = (c: string, at: string, viewed = 'VIEWED', path = 'src/a.ts') => ({
  path,
  viewed,
  headSha: sha(c),
  at,
});
const review = (c: string, submittedAt: string) => ({
  commit: sha(c),
  state: 'APPROVED',
  submittedAt,
});
const pick = (o: ReturnType<typeof sinceOptions>) =>
  o.map((x) => `${x.kind}:${x.headSha[0]}`);

Deno.test('sinceOptions: Viewed marks only, newest first, once each, not the head', () => {
  const history = [
    mark('b', '2026-11-03T10:00:00.000Z'),
    mark('c', '2026-11-02T10:00:00.000Z', 'UNVIEWED'),
    mark('a', '2026-11-02T09:00:00.000Z'),
    mark('b', '2026-11-01T10:00:00.000Z'),
    mark('f', '2026-11-04T10:00:00.000Z'),
  ];
  const got = sinceOptions(history, { headSha: HEAD, myReview: null });
  assertEquals(pick(got), ['viewed:b', 'viewed:a']);
  assertEquals(got[0].path, 'src/a.ts');
});

Deno.test('sinceOptions: a review only; at the head it is no option', () => {
  const got = sinceOptions([], {
    headSha: HEAD,
    myReview: review('r', '2026-11-03T10:00:00Z'),
  });
  assertEquals(got, [{
    kind: 'review',
    headSha: sha('r'),
    path: null,
    at: '2026-11-03T10:00:00Z',
  }]);
  assertEquals(
    sinceOptions([], {
      headSha: HEAD,
      myReview: review('f', '2026-11-03T10:00:00Z'),
    }),
    [],
  );
  assertEquals(sinceOptions(undefined, undefined), []);
});

Deno.test('sinceOptions: the latest point wins, Viewed mark or review', () => {
  const history = [mark('a', '2026-11-02T10:00:00.000Z')];
  assertEquals(
    pick(sinceOptions(history, {
      headSha: HEAD,
      myReview: review('r', '2026-11-03T10:00:00Z'),
    })),
    ['review:r', 'viewed:a'],
  );
  assertEquals(
    pick(sinceOptions(history, {
      headSha: HEAD,
      myReview: review('r', '2026-11-01T10:00:00Z'),
    })),
    ['viewed:a', 'review:r'],
  );
});

Deno.test('sinceOptions: times compare as instants, not strings', () => {
  // As strings, '…10:00:00.500Z' sorts before '…10:00:00Z' ('.' < 'Z'), though it is later.
  assertEquals(
    pick(sinceOptions([mark('a', '2026-11-02T10:00:00.500Z')], {
      headSha: HEAD,
      myReview: review('r', '2026-11-02T10:00:00Z'),
    })),
    ['viewed:a', 'review:r'],
  );
});

Deno.test('sinceOptions: a review at a Viewed head is one option, named by the later', () => {
  const history = [mark('a', '2026-11-02T10:00:00.000Z')];
  assertEquals(
    pick(sinceOptions(history, {
      headSha: HEAD,
      myReview: review('a', '2026-11-03T10:00:00Z'),
    })),
    ['review:a'],
  );
  assertEquals(
    pick(sinceOptions(history, {
      headSha: HEAD,
      myReview: review('a', '2026-11-01T10:00:00Z'),
    })),
    ['viewed:a'],
  );
});

Deno.test('latestSince: the later of the newest Viewed mark and the review, none at the head', () => {
  const pr = (myReview: unknown) => ({ headSha: HEAD, myReview });
  assertEquals(latestSince(null, pr(null)), null);
  const viewed = mark('a', '2026-11-02T10:00:00.000Z');
  assertEquals(latestSince(viewed, pr(null))?.headSha, sha('a'));
  assertEquals(
    latestSince(viewed, pr(review('r', '2026-11-03T10:00:00Z')))?.kind,
    'review',
  );
  assertEquals(
    latestSince(viewed, pr(review('r', '2026-11-01T10:00:00Z')))?.kind,
    'viewed',
  );
  // Viewed at the head since: nothing changed since, whatever came before.
  assertEquals(
    latestSince(
      mark('f', '2026-11-04T10:00:00.000Z'),
      pr(review('r', '2026-11-03T10:00:00Z')),
    ),
    null,
  );
  // Reviewed at the head after an older mark.
  assertEquals(
    latestSince(viewed, pr(review('f', '2026-11-03T10:00:00Z'))),
    null,
  );
  assertEquals(
    latestSince(mark('a', '2026-11-02T10:00:00.000Z', 'UNVIEWED'), pr(null)),
    null,
  );
});

Deno.test('sinceStat: added and deleted lines, null for the same text', () => {
  assertEquals(sinceStat(diffTexts('a\nb\nc\n', 'a\nB\nc\nd\n')!), {
    additions: 2,
    deletions: 1,
  });
  assertEquals(sinceStat(diffTexts('a\n', 'a\n')!), null);
  assertEquals(sinceStat(diffTexts('', 'x\ny\n')!), {
    additions: 2,
    deletions: 0,
  });
});
