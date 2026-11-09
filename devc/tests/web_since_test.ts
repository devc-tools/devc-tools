import { assertEquals } from 'jsr:@std/assert';
import { sinceOptions } from '../web/static/lib/since.js';

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
