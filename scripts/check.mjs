/**
 * Offline checks for the logic that decides what the CLI tells people.
 *
 * This repo validates by hand against a running backend, which is the only way
 * to check what the API actually does. These are the cases hand-testing cannot
 * reach: a stale compile needs a version counter deliberately advanced past a
 * synced one, and a truncated list needs a server that keeps claiming more
 * pages. Both are also where being wrong is expensive: a false "stale" sends
 * someone to pay for a recompile they do not need.
 *
 * No framework and no network. Run with: npm run check
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {spawnSync, execFile} from 'node:child_process'
import {
  freshnessOf,
  revisionsBehind,
  messagesAfterSync,
  freshnessLines,
  freshnessSummary,
  uploadWarningLines,
  readablePatternError,
  compileProgressLabel,
  compileStatusOf,
  readableLimit,
  extractReasoning,
  extractCause,
  extractStreamReasoning,
  extractStreamDelta,
  reasoningHeading,
  retryOnceOnWarmUp,
  faceRefusalHint,
  streamChat,
  resolveCause,
  seg,
  badFaceName, badToolNames, compileCostNote,
  table,
  usd,
  isCalendarDate,
  parseBudget,
  parseTemperature,
  chatExtras,
  faceStyles,
  localTime,
  startsAtLine,
  msUntilStart,
  makeScheduleLines,
  makeRefusalMessage,
  compileLimitText,
  compileFieldLine,
  similarityText,
  transcriptSpeakers,
  transcriptWarningLines,
  documentWarningLines,
  postChat,
  withoutWarnings,
  renameFaceFields,
} from '../dist/utils.js'
import fs from 'node:fs'
import {FacesClient, FacesAPIError, refusalGuidance, parseRetryAfter, readableDetail, streamErrorOf, heldChatError, looksOutOfDate, missingFieldsNote, outOfDateHint, rateLimitWait, compareVersions, CLI_VERSION} from '../dist/client.js'
import {parseDecisionOption, questionsProblem, toOpenAIDecision, fromOpenAIAnswers, decisionLines, causeLines, warmUpWait, MAX_WARM_UP_WAIT_S, heldDecisionError} from '../dist/decisions.js'
import {allowanceLines, cardLine, tokens, percentUsed, llmCostLab} from '../dist/billing.js'
import {decisionModelError} from '../dist/routing.js'
import {publicJob, autoTrigger, reportWarnings, jobFailureMessage, servedBy, styleCreditRefusal} from '../dist/style.js'
import {pollCompileProgress, pollUntilPaused} from '../dist/poll.js'
import {childPath} from '../dist/paths.js'
import {score10} from '../dist/fidelity.js'
import {resultLines, benchmarkHint} from '../dist/benchmark.js'
import {conversationHint, parsePremises, premiseValue, conversationFields, clientItems, conversationLines, itemLines, premiseLines, staleDecisionLines} from '../dist/conversation.js'

let failed = 0
let ran = 0

function eq(label, actual, expected) {
  ran++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return
  failed++
  console.error(`FAIL  ${label}\n      expected ${e}\n      got      ${a}`)
}

// --- freshness: the two unknown states must never read as stale ---------------
eq('current', freshnessOf({version: 3, synced_version: 3}), 'current')
eq('ahead of itself', freshnessOf({version: 2, synced_version: 5}), 'current')
eq('stale', freshnessOf({version: 5, synced_version: 3}), 'stale')
eq('synced_version null', freshnessOf({version: 1, synced_version: null}), 'unknown')
eq('version null', freshnessOf({version: null, synced_version: 1}), 'unknown')
eq('both absent', freshnessOf({}), 'unknown')

eq('behind: stale', revisionsBehind({version: 5, synced_version: 3}), 2)
eq('behind: current', revisionsBehind({version: 3, synced_version: 3}), null)
eq('behind: unknown', revisionsBehind({version: 3, synced_version: null}), null)

// --- messages against synced_at ----------------------------------------------
const sync = '2026-09-07T08:28:05.809735'
eq('msg before sync', messagesAfterSync([{timestamp: '2026-09-07T08:21:15.774859'}], sync), {newer: 0, unknown: 0})
eq('msg after sync', messagesAfterSync([{timestamp: '2026-09-07T09:00:00.000000'}], sync), {newer: 1, unknown: 0})
// A zone marker must not shift a timestamp into the future and invent a change.
eq('earlier but Z-suffixed', messagesAfterSync([{timestamp: '2026-09-07T08:00:00Z'}], sync), {newer: 0, unknown: 0})
eq('earlier with offset', messagesAfterSync([{timestamp: '2026-09-07T08:00:00+02:00'}], sync), {newer: 0, unknown: 0})
eq('no timestamp', messagesAfterSync([{}, {timestamp: null}], sync), {newer: 0, unknown: 2})
eq('unparseable sync', messagesAfterSync([{timestamp: sync}], 'not-a-date'), {newer: 0, unknown: 1})
eq('no synced_at', messagesAfterSync([{timestamp: sync}], null), {newer: 0, unknown: 0})
eq('no messages', messagesAfterSync([], sync), {newer: 0, unknown: 0})

// --- the lines people actually read ------------------------------------------
eq('current says nothing', freshnessLines({version: 1, synced_version: 1, compilable: true}, 'CMD'), [])
eq('unknown says nothing', freshnessLines({version: 1, synced_version: null, compilable: true}, 'CMD'), [])
eq(
  'stale offers the recompile',
  freshnessLines({version: 5, synced_version: 3, compilable: true}, 'CMD'),
  ['Stale: the text is 2 revision(s) ahead of the last compile.', '  Bring the compile up to date with: CMD'],
)
// Stale but refused: offering a recompile here is advice to pay for a refusal.
const blocked = freshnessLines(
  {version: 5, synced_version: 3, compilable: false, compile_blocked_reason: 'no_medium'},
  'CMD',
  'THE-ID',
)
eq('stale+blocked withholds the recompile', blocked.some((l) => l.includes('CMD')), false)
eq('stale+blocked names the refusal', blocked[1], 'A compile would be refused: no medium declared.')
eq('the fix carries the real id', blocked[2].includes('THE-ID'), true)
eq('and no placeholder survives', blocked.some((l) => l.includes('<id>')), false)

eq(
  'summary counts both readings',
  freshnessSummary(
    [
      {version: 1, synced_version: 1, compilable: true},
      {version: 5, synced_version: 3, compilable: true},
      {version: 1, synced_version: 1, compilable: false, compile_blocked_reason: 'no_medium'},
      {version: 1, synced_version: 1, compilable: false, compile_blocked_reason: 'corpus_thread'},
      {version: 1, synced_version: 1, compilable: false, compile_blocked_reason: 'corpus_thread'},
    ],
    'document',
  ),
  [
    '1 document(s) changed since the last compile and need recompiling.',
    '3 the server would refuse: 2 corpus thread, 1 no medium declared.',
  ],
)
eq('summary silent when all is well', freshnessSummary([{version: 1, synced_version: 1, compilable: true}], 'document'), [])

// --- upload warnings: a 200 says nothing about what was dropped -------------
eq('clean upload is silent', uploadWarningLines({warnings: [], warning_count: 0}), [])
eq('absent keys are silent', uploadWarningLines({}), [])
eq(
  'the server sentence is preferred over ours',
  uploadWarningLines({
    warning_count: 1,
    warnings: [{code: 'unattributed_lines', message: '3 line(s) were left out.', count: 3}],
  }),
  [
    'Warning: 1 part(s) of the file did not become messages.',
    '  unattributed_lines: 3 line(s) were left out.',
    '    If they matter, give them a speaker prefix and upload again.',
  ],
)
// No message: ours stands in, because the entry shape is open-ended.
eq(
  'our sentence stands in',
  uploadWarningLines({warning_count: 1, warnings: [{code: 'face_speaker_not_found'}]})[1].includes('matched nobody'),
  true,
)
// An unrecognised code must still be reported, not swallowed.
eq(
  'unknown code still reported',
  uploadWarningLines({warning_count: 1, warnings: [{code: 'something_new'}]}),
  ['Warning: 1 part(s) of the file did not become messages.', '  something_new: see --json for detail.'],
)
// warning_count is exact while the list is capped, so the count wins.
eq(
  'capped list says so',
  uploadWarningLines({warning_count: 9, warnings: [{code: 'unattributed_lines', message: 'x'}]}).at(-1),
  '  Showing 1 of 9; the rest are in the same shape.',
)
eq('uncapped list says nothing extra', uploadWarningLines({
  warning_count: 1,
  warnings: [{code: 'unattributed_lines', message: 'x'}],
}).some((l) => l.includes('Showing')), false)

// --- a rejected enum should read as a sentence, not a regex -----------------
eq(
  'query pattern becomes words',
  readablePatternError("query → sort: String should match pattern '^(created|alias|relevance|usage)$'"),
  '--sort must be one of: created, alias, relevance, usage',
)
eq(
  'order too',
  readablePatternError("query → order: String should match pattern '^(asc|desc)$'"),
  '--order must be one of: asc, desc',
)
// An underscore field name becomes the flag spelling a caller would have typed.
eq(
  'underscores become dashes',
  readablePatternError("body → sort_by: String should match pattern '^(a|b)$'"),
  '--sort-by must be one of: a, b',
)
// Anything that is not that shape is passed through untouched, so an unrelated
// 422 is never reworded into something it does not say.
for (const [label, msg] of [
  ['plain message', 'Face not found'],
  ['pattern without alternatives', "query → sort: String should match pattern '^[a-z]+$'"],
  ['different 422 shape', 'query → limit: Input should be less than or equal to 500'],
  ['empty', ''],
]) {
  eq(`passthrough: ${label}`, readablePatternError(msg), msg)
}

// --- compile progress: status and progress, a percentage only where one is real
// Queued work waits behind the face's other sources and reads as queued, never "0%".
eq('source, queued', compileProgressLabel({status: 'queued', progress: 0}), 'queued')
eq('source, compiling', compileProgressLabel({status: 'compiling', progress: 0.43}), 'compiling, 43%')
eq('source, compiled', compileProgressLabel({status: 'compiled', progress: 1}), 'compiled')
eq('source, not compiled', compileProgressLabel({status: 'not_compiled', progress: 0}), 'not compiled')
eq('source, paused', compileProgressLabel({status: 'paused', progress: 0.5}), 'paused, 50%')
eq('source, transcribing without progress', compileProgressLabel({status: 'transcribing', progress: null}), 'transcribing')
// A state added after this release reads as still running, never as done or failed.
eq('unknown status', compileProgressLabel({status: 'warming_up', progress: 0.2}), 'compiling, 20%')
eq('status of unknown', compileStatusOf('warming_up'), 'compiling')
eq('status of null', compileStatusOf(null), null)
// A group that says it is measurable gets a percentage.
eq('group, measurable', compileProgressLabel({measurable: true, progress: 0.4}), '40%')
// A group that says it is not gets none, even if a number is present.
eq('group, not measurable', compileProgressLabel({measurable: false, progress: null}), 'working, progress not known yet')
eq('group, not measurable, number present', compileProgressLabel({measurable: false, progress: 0.4}), 'working, progress not known yet')
eq('empty object', compileProgressLabel({}), 'working, progress not known yet')
// Out of range is clamped rather than printed as 140%.
eq('clamped', compileProgressLabel({status: 'compiling', progress: 1.4}), 'compiling, 100%')
// The old fields are gone: a body carrying only them has no progress to show.
eq('old fields ignored', compileProgressLabel({parts_completed: 8, parts_total: 20}), 'working, progress not known yet')

// --- scheduled start and rush: when a compile starts, in the local zone --------
{
  const tz = process.env.TZ
  process.env.TZ = 'UTC'
  const now = Date.parse('2026-10-22T14:22:00Z')
  const at = '2026-10-22T15:00:00+00:00'
  eq('start: local time', localTime(at), '2026-10-22 15:00 UTC')
  eq('start: no zone is UTC', localTime('2026-10-22T15:00:00'), '2026-10-22 15:00 UTC')
  eq('start: ahead is the scheduled start', startsAtLine(at, now), 'Scheduled start: 2026-10-22 15:00 UTC (in 38 min)')
  eq('start: over an hour', startsAtLine('2026-10-22T15:30:00Z', now), 'Scheduled start: 2026-10-22 15:30 UTC (in 1 h 8 min)')
  eq('start: past is when it started', startsAtLine('2026-10-22T14:00:00Z', now), 'Started: 2026-10-22 14:00 UTC')
  eq('start: null starts at once', startsAtLine(null, now), undefined)
  eq('start: wait', msUntilStart(at, now), 38 * 60_000)
  eq('start: no wait once past', msUntilStart('2026-10-22T14:00:00Z', now), 0)
  eq('label: queued with a scheduled start', compileProgressLabel({status: 'queued', progress: 0, starts_at: at}, now), 'queued, starts 2026-10-22 15:00 UTC')
  eq('label: queued as a rush', compileProgressLabel({status: 'queued', progress: 0, starts_at: at, rush: true}, now), 'queued, rush')
  eq('label: queued, start passed', compileProgressLabel({status: 'queued', progress: 0, starts_at: '2026-10-22T14:00:00Z'}, now), 'queued')
  eq('make: scheduled', makeScheduleLines({starts_at: at, rush: false}, false, now), ['Scheduled start: 2026-10-22 15:00 UTC (in 38 min)'])
  eq('make: rush', makeScheduleLines({starts_at: '2026-10-22T14:22:00Z', rush: true}, true, now), ['Rush: it starts now, at the rush rate.'])
  eq('make: at once says nothing', makeScheduleLines({starts_at: null, rush: false}, false, now), [])
  eq('make: --rush where it starts at once', makeScheduleLines({starts_at: null, rush: false}, true, now), ['It starts now at the standard rate, so --rush changed nothing and costs nothing extra.'])
  eq('field: start ahead', compileFieldLine('starts_at', at, now), 'scheduled start: 2026-10-22 15:00 UTC (in 38 min)')
  eq('field: null start left out', compileFieldLine('starts_at', null, now), null)
  eq('field: rush false left out', compileFieldLine('rush', false), null)
  eq('field: rush true', compileFieldLine('rush', true), 'rush: yes, at the rush rate')
  eq('field: other keys untouched', compileFieldLine('status', 'queued'), undefined)
  process.env.TZ = tz ?? ''
  if (tz === undefined) delete process.env.TZ
}
// tokens_limit: 0 is no allowance and -1 unlimited, never "0/0" or "-1".
eq('compile limit: none', compileLimitText(0), 'none on this plan (compiles are paid per source token)')
eq('compile limit: unlimited', compileLimitText(-1), 'unlimited')
eq('compile limit: a number', compileLimitText(250000), '250,000 source tokens')
eq('field: tokens_limit 0', compileFieldLine('tokens_limit', 0), 'compile allowance this month: none on this plan (compiles are paid per source token)')
eq('field: tokens_limit -1', compileFieldLine('tokens_limit', -1), 'compile allowance this month: unlimited')
eq('field: tokens_used', compileFieldLine('tokens_used', 1200), 'compiled this month: 1,200 source tokens')
{
  const rushErr = new FacesAPIError(402, 'Payment required: not enough credit for the rush', {errorCode: 'insufficient_credit_for_rush', details: {rush_premium_usd: 1.25}})
  eq('rush refusal: names the premium', makeRefusalMessage(rushErr, 'd1'), 'Payment required: not enough credit for the rush\nRush premium: $1.25, paid from credit.')
  eq('rush refusal: guidance', /without --rush/.test(refusalGuidance(402, 'insufficient_credit_for_rush', 'x') ?? ''), true)
  eq('rush refusal: still says top up', /billing:topup/.test(refusalGuidance(402, 'insufficient_credit_for_rush', 'x') ?? ''), true)
  eq('blocked refusal: the fix', makeRefusalMessage(new FacesAPIError(400, 'No medium.', {errorCode: 'no_medium'}), 'd9').includes('compile:doc:edit d9'), true)
  eq('other refusal: status and message', makeRefusalMessage(new FacesAPIError(500, 'boom'), 'd1'), 'HTTP 500: boom')
  eq('too late to rush: says so', /--rush no longer applies/.test(makeRefusalMessage(new FacesAPIError(409, 'This document\'s compile has already started, so it can no longer be rushed.', {errorCode: 'compile_already_started'}), 'd1')), true)
  eq('queued make: points at --rush', /again with --rush/.test(makeRefusalMessage(new FacesAPIError(409, 'Compilation already in progress for this document'), 'd1')), true)
  eq('field: rush premium', compileFieldLine('rush_premium_usd', 1.25), 'rush now: $1.25 from credit (make again with --rush)')
  eq('field: rush premium null left out', compileFieldLine('rush_premium_usd', null), null)
  eq('field: rush premium zero', /no extra charge/.test(compileFieldLine('rush_premium_usd', 0) ?? ''), true)
}

// --- pagination, against a server that is deliberately awkward ---------------
async function paging() {
  let endless = false
  let repeatCursor = false
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    res.setHeader('content-type', 'application/json')
    if (u.pathname !== '/v1/faces') {
      res.statusCode = 404
      res.end('{}')
      return
    }

    const limit = Number(u.searchParams.get('limit') ?? 100)
    const start = Number((u.searchParams.get('cursor') ?? 'c0').slice(1))
    const total = 40
    const rows = []
    for (let i = start; i < Math.min(start + limit, total); i++) rows.push({alias: `f${i}`})
    const more = endless || start + limit < total
    res.end(
      JSON.stringify({
        object: 'list',
        data: rows,
        has_more: more,
        next_cursor: more ? (repeatCursor ? 'c0' : `c${start + limit}`) : null,
      }),
    )
  })

  await new Promise((r) => srv.listen(0, r))
  const client = new FacesClient(`http://127.0.0.1:${srv.address().port}`, undefined, 'sk-check')

  for (const size of [1, 3, 7, 40, 100]) {
    const r = await client.getAll('/v1/faces', {pageSize: size})
    eq(`paging at ${size}: rows`, r.data.length, 40)
    eq(`paging at ${size}: no duplicates`, new Set(r.data.map((f) => f.alias)).size, 40)
    eq(`paging at ${size}: complete`, r.truncated, false)
  }

  // A server that never stops claiming more must not spin the loop forever.
  endless = true
  const capped = await client.getAll('/v1/faces', {pageSize: 10, maxPages: 4})
  eq('page cap engages', capped.pages, 4)
  eq('page cap reports truncation', capped.truncated, true)

  // Nor may a repeated cursor.
  repeatCursor = true
  const looped = await client.getAll('/v1/faces', {pageSize: 10})
  eq('repeated cursor breaks out', looped.truncated, true)
  eq('repeated cursor stops early', looped.pages < 10, true)

  srv.close()
}

await paging()

// --- decisions ------------------------------------------------------------------
eq('option: plain', parseDecisionOption('no=declines to sign'), {name: 'no', definition: 'declines to sign'})
eq('option: = in definition', parseDecisionOption('yes=signs it = agrees'), {name: 'yes', definition: 'signs it = agrees'})
eq('option: bare name has no description', parseDecisionOption('yes'), {name: 'yes', definition: null})
eq('option: empty description is none', parseDecisionOption('yes='), {name: 'yes', definition: null})
eq('option: empty name', parseDecisionOption('=signs'), undefined)
eq(
  'decision lines: choice, most likely first, one decimal',
  decisionLines({sign: {type: 'choice', choice: 'no', confidence: 0.98, probabilities: {yes: 0, no: 0.995, later: 0.005}}}, 10),
  ['sign: no, confidence 0.98', '  no      99.5%  ##########', '  later    0.5%', '  yes      0.0%'],
)
eq(
  'decision lines: noul',
  decisionLines({irked: {type: 'noul', noul: 0.75}}, 4),
  ['irked: yes 75.0%', '  yes   75.0%  ###', '  no    25.0%  #'],
)
eq(
  'decision lines: score labelled from the legend',
  decisionLines({firm: {type: 'score', score: 1.99, confidence: 1, legend: {0: 'yields', 1: 'hedges', 2: 'firm'}, probabilities: {0: 0, 1: 0.01, 2: 0.99}}}, 4),
  ['firm: 1.99 on 0 to 2, confidence 1.00', '  2 firm     99.0%  ####', '  1 hedges    1.0%', '  0 yields    0.0%'],
)
eq('decision lines: a non-number is a dash, not NaN%', decisionLines({q: {type: 'choice', choice: 'a', probabilities: {a: 1, b: null}}}, 4), ['q: a', '  a  100.0%  ####', '  b  -'])
eq('decision lines: an unknown type is shown, not dropped', decisionLines({q: {type: 'new', x: 1}}), ['q', '  {"type":"new","x":1}'])

eq('cause lines: one when every question shares it', causeLines({cause: 'c', causes: {a: 'c'}}, ['a']), ['c'])
eq('cause lines: per question when they differ', causeLines({cause: 'c', causes: {a: 'c', b: 'd'}}, ['a', 'b']), ['a:', 'c', '', 'b:', 'd'])
eq('cause lines: a question missing from causes falls back to cause', causeLines({cause: 'c', causes: {b: 'd'}}, ['a', 'b']), ['a:', 'c', '', 'b:', 'd'])
eq('cause lines: the old reasoning field is not read', causeLines({reasoning: 'r'}, ['a']), [])
eq('cause lines: face alone', causeLines({cause: 'c'}, []), ['c'])

// --- the update hint ---------------------------------------------------------------
eq('out of date: a route that is gone', looksOutOfDate(404, 'Not Found'), true)
eq('out of date: a face that is missing is not', looksOutOfDate(404, 'Face x not found'), false)
eq('out of date: a top-level field the CLI did not send', looksOutOfDate(422, 'body → model: Field required'), true)
eq('out of date: a fault inside a questions file is not', looksOutOfDate(422, 'body → questions → q → instructions: Field required'), false)
eq('out of date: an unknown medium is not', looksOutOfDate(422, 'Unknown medium'), false)
eq('missing fields: none', missingFieldsNote({cause: 'c'}, ['cause']), undefined)
eq('missing fields: named with the update', missingFieldsNote({}, ['cause']), `The Faces API response did not include \`cause\`. ${outOfDateHint()}`)
eq('update hint names the version', outOfDateHint().includes(`(${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version})`), true)

// --- the face's reasoning, where each API keeps it ------------------------------
eq('reasoning: chat cause', extractReasoning({choices: [{message: {content: null, cause: 'r'}}]}, '/v1/chat/completions'), 'r')
eq('reasoning: chat reasoning_content is the model\'s, not the face\'s', extractReasoning({choices: [{message: {content: 't', reasoning_content: 'm'}}]}, '/v1/chat/completions'), '')
eq('cause: responses face item, with its id', extractCause({output: [{type: 'reasoning', id: 'rs_abc', summary: [{text: 'm'}]}, {type: 'reasoning', id: 'rs_faces_1', summary: [{text: 'r'}]}, {type: 'message'}]}, '/v1/responses'), {text: 'r', id: 'rs_faces_1'})
eq('reasoning: responses none', extractReasoning({output: [{type: 'message'}]}, '/v1/responses'), '')
eq('reasoning: messages faces block only', extractReasoning({content: [{type: 'thinking', thinking: 'm', signature: 'sig'}, {type: 'thinking', thinking: 'r', signature: 'faces-reasoning'}, {type: 'text', text: 't'}]}, '/v1/messages'), 'r')
eq('reasoning: messages none', extractReasoning({content: [{type: 'text', text: 't'}]}, '/v1/messages'), '')
eq('stream reasoning: chat cause', extractStreamReasoning({choices: [{delta: {cause: 'r'}}]}), 'r')
eq('stream reasoning: chat reasoning_content is the model\'s', extractStreamReasoning({choices: [{delta: {reasoning_content: 'm'}}]}), '')
eq('stream reasoning: chat content is not reasoning', extractStreamReasoning({choices: [{delta: {content: 't'}}]}), '')
eq('stream reasoning: messages block 0', extractStreamReasoning({type: 'content_block_delta', index: 0, delta: {thinking: 'r'}}), 'r')
eq('stream reasoning: the model\'s own thinking is not the face\'s', extractStreamReasoning({type: 'content_block_delta', index: 1, delta: {thinking: 'm'}}), '')
eq('stream reasoning: responses face item', extractStreamReasoning({type: 'response.reasoning_summary_text.delta', item_id: 'rs_faces_1', delta: 'r'}), 'r')
eq('stream reasoning: responses model item', extractStreamReasoning({type: 'response.reasoning_summary_text.delta', item_id: 'rs_abc', delta: 'm'}), '')
eq('stream text: thinking is not text', extractStreamDelta({type: 'content_block_delta', index: 0, delta: {thinking: 'r'}}), '')
eq('cause heading: no model', reasoningHeading('alice@gpt-5.4'), "alice's cause:")
eq('chat extras: only what was given', chatExtras({style: 'email', session: 'fs_1'}), {style: 'email', session: 'fs_1'})
eq('chat extras: medium and compaction', chatExtras({medium: 'essay', compaction: 'fcmp_1'}), {medium: 'essay', compaction: 'fcmp_1'})

// --- warm-up: honour Retry-After exactly, and only a 503 that carries one -------
eq('retry-after: seconds', parseRetryAfter('87'), 87)
eq('retry-after: padded', parseRetryAfter(' 5 '), 5)
eq('retry-after: http date is not read', parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT'), undefined)
eq('retry-after: absent', parseRetryAfter(null), undefined)
eq('wait: 503 with header', warmUpWait(503, 87, 0), 87)
eq('wait: 503 without header is not a warm-up', warmUpWait(503, undefined, 0), undefined)
eq('wait: other status never waits', warmUpWait(502, 30, 0), undefined)
eq('wait: stops at the ceiling', warmUpWait(503, 120, MAX_WARM_UP_WAIT_S - 100), undefined)
eq('wait: zero is honoured', warmUpWait(503, 0, 0), 0)

// --- an OAuth refusal's sentence, not its JSON -----------------------------------
eq(
  'detail: provider JSON string unwrapped',
  readableDetail('{"detail":"The \'gpt-x\' model is not supported on this plan."}'),
  "The 'gpt-x' model is not supported on this plan.",
)
eq('detail: plain sentence kept', readableDetail('ChatGPT ended its reply.'), 'ChatGPT ended its reply.')
eq('detail: not a string', readableDetail({a: 1}), undefined)

// --- unlimited is negative, and must never read as used up ---------------------
eq('limit: -1', readableLimit(-1), 'unlimited')
eq('limit: 0 is a real zero', readableLimit(0, 'tokens'), '0 tokens')
eq('limit: null', readableLimit(null), '-')
const connect = {
  plan: 'connect',
  allowances: {
    cause_5h: {limit: 640000, used: 14500, remaining: 625500, resets_at: null},
    cause_week: {limit: 2500000, used: 14500, remaining: 2485500, resets_at: '2026-10-19T09:44:30.953480'},
    cause_month: {limit: 10000000, used: 14500, remaining: 9985500, resets_at: '2026-10-28T09:44:30.953480'},
    compile_month: {limit: 250000, used: 0, remaining: 250000, resets_at: '2026-10-28T09:44:30.953480'},
  },
  rates: {cause_usd_per_million_input_tokens: 0.75, cause_added_tokens: 1500, compile_usd_per_million_source_tokens: 25, model_markup: 0.05},
}
const meter = allowanceLines(connect)
eq('allowance: heading', meter[0], 'Connect allowances (tokens):')
eq('allowance: 5h rolls', meter[1], '  causes, rolling 5 hours  14.5k of 640k (2%)   rolls')
eq('allowance: week resets', meter[2], '  causes, this week        14.5k of 2.5M (<1%)  resets 2026-10-19 09:44 UTC')
eq('allowance: compile', meter[4], '  compile, this month      0 of 250k (0%)       resets 2026-10-28 09:44 UTC')
eq('allowance: past it names the rates', /\$0\.75 per million cause tokens, each cause counting its input tokens plus 1,500, and \$25 per million compile/.test(meter[5]), true)
eq('allowance: no added tokens, no clause', /\$1 per million cause tokens and \$25/.test(allowanceLines({...connect, rates: {cause_usd_per_million_input_tokens: 1, compile_usd_per_million_source_tokens: 25}})[5]), true)
eq('allowance: free has none', allowanceLines({plan: 'free', allowances: null}), [])
eq('allowance: a zero limit is none, not 0 of 0', allowanceLines({plan: 'pro', allowances: {compile_month: {limit: 0, used: 0, resets_at: '2026-11-01T00:00:00'}}})[1], '  compile, this month  none, paid per token')
eq('allowance: a zero unknown key is none too', allowanceLines({plan: 'pro', allowances: {decide_day: {limit: 0, used: 0}}})[1].includes('none, paid per token'), true)
eq('allowance: names the rush rate', /\$25 per million compile tokens \(\$30 for a rush\)\./.test(allowanceLines({...connect, rates: {...connect.rates, compile_rush_usd_per_million_source_tokens: 30}})[5]), true)
const team = allowanceLines({plan: 'team', allowances: {cause_month: {limit: -1, used: 900, remaining: null, resets_at: '2026-11-01T00:00:00'}}})
eq('allowance: team is unlimited, never used up', team, ['Team allowances (tokens):', '  causes, this month  900 used, unlimited'])
eq('allowance: an unknown key still shows', allowanceLines({plan: 'pro', allowances: {decide_day: {limit: 10, used: 2}}}).some((l) => l.includes('decide_day')), true)
eq('tokens', [tokens(400000), tokens(1600000), tokens(6300000), tokens(14500), tokens(651), tokens(null)], ['400k', '1.6M', '6.3M', '14.5k', '651', '-'])
eq('card line', cardLine({id: 'pm_1', brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2029, is_default: true}), 'visa ending 4242, expires 08/2029  pm_1  (default)')
eq('card line, not default', cardLine({id: 'pm_2', brand: 'mastercard', last4: '4444'}), 'mastercard ending 4444  pm_2')

// --- refusals that hinge on api_fallback ----------------------------------------
eq('429 allowance gets guidance', typeof refusalGuidance(429, undefined, 'Connect allowance of $20 used'), 'string')
eq('429 allowance guidance names the setting', refusalGuidance(429, undefined, 'Your Connect plan has used its weekly allowance (1,600,000 of 1,600,000 tokens).'), 'To continue on credits until it resets: faces account:preferences api_fallback true')
eq('402 says top up', refusalGuidance(402, undefined, 'no credit'), 'Add credit with: faces billing:topup --amount <usd>')
eq('429 rate limit is not told about api_fallback', /api_fallback/.test(refusalGuidance(429, undefined, 'Rate limit exceeded') ?? ''), false)
eq('502 oauth_incomplete gets guidance', typeof refusalGuidance(502, 'oauth_incomplete', 'stopped'), 'string')
eq('502 other does not', refusalGuidance(502, undefined, 'upstream failed'), undefined)

// --- report whitelist: new keys go out, but only their documented insides -------
const job = publicJob({
  job_id: 'j',
  report: {
    auto: {medium: 'email', multiple: 3, words: 50322, threshold: 15000, trigger: 'upload', oauth_only: true, face_id: 'f', internal_x: 1},
    thin_corpus: {essay: {words: 4200, threshold: 10000, internal_y: 2}},
    skipped_third_person: ['d1', {id: 'd2', label: 'Bio', internal_z: 3}],
    some_internal_key: 4,
  },
})
eq('whitelist: auto insides', Object.keys(job.report.auto).sort(), ['medium', 'multiple', 'oauth_only', 'threshold', 'trigger', 'words'])
eq('whitelist: thin_corpus insides', job.report.thin_corpus, {essay: {words: 4200, threshold: 10000}})
eq('whitelist: skipped insides', job.report.skipped_third_person, ['d1', {id: 'd2', label: 'Bio'}])
eq('whitelist: unknown top-level key stays behind', 'some_internal_key' in job.report, false)

eq(
  'auto trigger phrase',
  autoTrigger(job),
  'automatic build after an upload (50322 words, past 3x the 15000-word threshold)',
)
eq('manual job has no trigger', autoTrigger({report: {}}), undefined)
eq('warnings: skipped and thin', reportWarnings(job).length, 3)
eq('warnings: empty report is quiet', reportWarnings({report: {thin_corpus: {}, skipped_third_person: []}}), [])
eq('failure: CONNECT_REQUIRED names --allow-paid', /--allow-paid/.test(jobFailureMessage('CONNECT_REQUIRED: no free route')), true)
eq('failure: nothing linked is not "expired"', [/No ChatGPT account is linked/.test(jobFailureMessage('CHATGPT_AUTH: sign-in expired', false)), /expired\. Reconnect/.test(jobFailureMessage('CHATGPT_AUTH: x', false))], [true, false])
eq('failure: a linked account is reconnected', /most likely expired/.test(jobFailureMessage('CHATGPT_AUTH: x', true)), true)
eq('failure: unknown link says how to check', /auth:connections/.test(jobFailureMessage('CHATGPT_AUTH: x')), true)
eq('failure: MODEL_NOT_FREE points at the default route', /Leave out --model/.test(jobFailureMessage('MODEL_NOT_FREE: x')), true)
eq('failure: a referenced fault is neutral and keeps the reference', [/failed internally/, /reference 0a1b2c3d4e5f/].map((re) => re.test(jobFailureMessage('Could not build. Reference 0a1b2c3d4e5f.'))), [true, true])
eq('failure: a 500 never prints the server text', /secret detail/.test(jobFailureMessage('secret detail', undefined, undefined, 500)), false)
eq('failure: an internal code is a fault', /failed internally/.test(jobFailureMessage('anything', undefined, 'internal_error')), true)
eq('failure: a deliberate message is not a fault', jobFailureMessage('Not enough to build from.'), 'Not enough to build from.')
eq('served by: the link', servedBy({served_by: {route: 'chatgpt', model: 'gpt-5.6-terra', fell_back: false}}), 'your linked ChatGPT account (gpt-5.6-terra)')
eq('served by: fell back', servedBy({served_by: {route: 'faces', model: 'mercury-3', fell_back: true}}), 'Faces (mercury-3), after the ChatGPT link failed, the rest charged to credits')
eq('served by: off the link is charged', servedBy({served_by: {route: 'faces', model: 'mercury-3', fell_back: false}}), 'Faces (mercury-3), charged to credits')
eq('served by: the link is never called charged', /charged/.test(servedBy({served_by: {route: 'chatgpt', model: 'm', fell_back: false}})), false)
eq('failure: an automatic build short of credit says top up', [/billing:topup/, /tried again later/].map((re) => re.test(jobFailureMessage('Not enough credit.', undefined, 'insufficient_credit_for_style_build'))), [true, true])
{
  const msg = styleCreditRefusal({estimated_usd: 3.4, balance_usd: 1.25})
  eq('style 402: estimate and balance', [/up to \$3\.40/.test(msg), /balance is \$1\.25/.test(msg)], [true, true])
  eq('style 402: suggests the shortfall', /billing:topup --amount 3\b/.test(msg), true)
  eq('style 402: nothing charged', /nothing was charged/.test(msg), true)
  eq('style 402: without figures', /--amount <usd>/.test(styleCreditRefusal(undefined)), true)
}
// Similarity: never padded, so a score rounded to one place reads as one.
eq('similarity: rounded stays one place', similarityText(0.8), '0.8')
eq('similarity: negative', similarityText(-0.3), '-0.3')
eq('similarity: exact is cut to four places', similarityText(0.834567891), '0.8346')
eq('similarity: missing', similarityText(null), '-')
eq('served by: absent', servedBy({}), undefined)
eq('served_by is public, its inner keys whitelisted', publicJob({report: {served_by: {route: 'faces', model: 'm', fell_back: false, extra: 1}}}).report.served_by, {route: 'faces', model: 'm', fell_back: false})


// --- streaming: keep-alives skipped, late refusals thrown ----------------------
eq('chat late refusal', (() => { const e = streamErrorOf('{"error": {"message": "reasoning failed. Nothing was charged.", "code": 503}}'); return [e.statusCode, e.message] })(), [503, 'reasoning failed. Nothing was charged.'])
eq('responses late refusal', (() => { const e = streamErrorOf('{"type": "error", "code": "503", "message": "m"}'); return [e.statusCode, e.message] })(), [503, 'm'])
eq('messages late refusal', (() => { const e = streamErrorOf('{"type": "error", "error": {"type": "overloaded_error", "message": "m"}}'); return [e.statusCode, e.message] })(), [503, 'm'])
eq('messages invalid request is 400', streamErrorOf('{"type": "error", "error": {"type": "invalid_request_error", "message": "m"}}').statusCode, 400)
eq('an unnamed code is 503', streamErrorOf('{"error": {"message": "m"}}').statusCode, 503)
eq('a chunk that says error is not one', streamErrorOf('{"choices": [{"delta": {"content": "an error"}}]}'), undefined)
eq('a null error is not one', streamErrorOf('{"error": null, "choices": []}'), undefined)
eq('a text delta that says error is not one', streamErrorOf('{"type": "response.output_text.delta", "delta": "error"}'), undefined)
eq('[DONE] is not one', streamErrorOf('[DONE]'), undefined)
eq('chat stream: a named code is kept', streamErrorOf('{"error": {"message": "m", "type": "faces_error", "code": "oauth_rejected"}}')?.errorCode, 'oauth_rejected')
eq('chat stream: a numeric code is the status', streamErrorOf('{"error": {"message": "m", "type": "faces_error", "code": 409}}')?.statusCode, 409)
eq('responses stream: a named code is kept', streamErrorOf('{"type": "error", "code": "oauth_rejected", "message": "m", "param": null}')?.errorCode, 'oauth_rejected')
eq('messages stream: a named code is kept', streamErrorOf('{"type": "error", "error": {"type": "api_error", "message": "m", "code": "oauth_rejected"}}')?.errorCode, 'oauth_rejected')
eq('chat stream: status beside a named code', streamErrorOf('{"error": {"message": "m", "type": "faces_error", "code": "oauth_rejected", "status": 409}}')?.statusCode, 409)
eq('responses stream: status beside a named code', streamErrorOf('{"type": "error", "code": "oauth_rejected", "status": 409, "message": "m", "param": null}')?.statusCode, 409)
eq('messages stream: status in error', streamErrorOf('{"type": "error", "error": {"type": "api_error", "message": "m", "code": "oauth_rejected", "status": 409}}')?.statusCode, 409)
eq('chat stream: retryable false is kept', streamErrorOf('{"error": {"message": "m", "type": "provider_error", "code": 503, "status": 503, "retryable": false}}')?.retryable, false)
eq('held body: retryable false is kept', heldChatError({detail: 'm', error: {message: 'm', type: 'provider_error', status: 503, retryable: false}})?.retryable, false)
eq('details carry retryable', new FacesAPIError(503, 'm', {details: {type: 'provider_error', retryable: false}}).retryable, false)
eq('503 not retryable: no "try again" hint', faceRefusalHint(new FacesAPIError(503, 'This model is not available right now. Try another model.', {retryable: false}), 'alice@x'), undefined)
eq('503 retryable: try again', faceRefusalHint(new FacesAPIError(503, 'm', {retryable: true}), 'alice@x'), 'Try again.')

async function streaming() {
  let mode = ''
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits++
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body)
      if (mode === 'rename' && payload.max_tokens !== undefined) {
        res.writeHead(400, {'Content-Type': 'application/json'})
        res.end(JSON.stringify({detail: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}))
        return
      }
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'X-Faces-Provider': 'openai'})
      res.write(': keep-alive\n\n')
      res.write(': keep-alive\r\n\r\n')
      if (mode === 'late') {
        res.write('data: {"error": {"message": "the reasoning failed. Nothing was charged.", "code": 503}}\n\n')
        res.end('data: [DONE]\n\n')
        return
      }
      res.write('data: {"choices": [{"delta": {"cause": "hm"}}]}\n\n')
      res.write('data: {"choices": [{"delta": {"content": "hi"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((r) => srv.listen(0, r))
  const client = new FacesClient(`http://127.0.0.1:${srv.address().port}`, undefined, 'k')
  try {
    mode = 'ok'
    let seen
    const lines = []
    for await (const l of client.stream('/v1/chat/completions', {}, {onHeaders: (h) => (seen = h)})) lines.push(l)
    eq('keep-alives skipped', lines, ['data: {"choices": [{"delta": {"cause": "hm"}}]}', 'data: {"choices": [{"delta": {"content": "hi"}}]}', 'data: [DONE]'])
    eq('headers seen', seen['x-faces-provider'], 'openai')

    mode = 'late'
    let caught
    try {
      for await (const l of client.stream('/v1/chat/completions', {})) void l
    } catch (e) {
      caught = e
    }
    eq('late refusal thrown', [caught instanceof FacesAPIError, caught?.statusCode, caught?.message], [true, 503, 'the reasoning failed. Nothing was charged.'])

    mode = 'rename'
    hits = 0
    const payload = {max_tokens: 50}
    const got = []
    for await (const l of streamChat(client, '/v1/chat/completions', payload)) got.push(l)
    eq('max_tokens renamed and asked again', [hits, payload, got.length], [2, {max_completion_tokens: 50}, 3])
  } finally {
    srv.close()
  }
}
await streaming()

// --- warm-up: one retry after Retry-After, nothing else retried ----------------
async function warmUp() {
  const refusal = (status, retryAfter) => new FacesAPIError(status, 'm', {retryAfter})
  let calls = 0
  const waits = []
  const ok = await retryOnceOnWarmUp(async () => { if (calls++ === 0) throw refusal(503, 0); return 'done' }, (s) => waits.push(s))
  eq('warm-up retried once', [ok, calls, waits], ['done', 2, [0]])

  calls = 0
  let err
  try { await retryOnceOnWarmUp(async () => { calls++; throw refusal(503, 0) }) } catch (e) { err = e }
  eq('a second warm-up is not retried', [calls, err?.statusCode], [2, 503])

  for (const [label, e] of [['503 without Retry-After', refusal(503)], ['409', refusal(409)], ['past the ceiling', refusal(503, MAX_WARM_UP_WAIT_S + 1)]]) {
    calls = 0
    try { await retryOnceOnWarmUp(async () => { calls++; throw e }) } catch { /* expected */ }
    eq(`${label} is not retried`, calls, 1)
  }
}
await warmUp()

eq('409 hint: recompile', /faces face:sources alice/.test(faceRefusalHint(new FacesAPIError(409, 'm'), 'alice@gpt-5.4')), true)
eq('409 hint: someone else\'s face', faceRefusalHint(new FacesAPIError(409, 'm'), 'head:socrates@x'), 'head:socrates needs recompiling by its owner before it can answer.')
eq('no styles: build one', faceRefusalHint(new FacesAPIError(400, "'alice' has no styles yet."), 'alice@x', 'email'), "Build one: faces style:make alice --all\nOr leave out --style to answer without a built style.")
eq('no style in that medium: build one', /^Build one/.test(faceRefusalHint(new FacesAPIError(400, 'This face has no lecture style. Its styles: email'), 'alice@x', 'lecture') ?? ''), true)
eq('a style hint needs --style', faceRefusalHint(new FacesAPIError(400, "'alice' has no styles yet."), 'alice@x'), undefined)
eq('faceStyles reads styles', faceStyles({styles: ['email', 'essay']}), ['email', 'essay'])
eq('faceStyles: none', [faceStyles({styles: []}), faceStyles({}), faceStyles({styles: null})], [[], [], []])
eq('503 hint: try again', faceRefusalHint(new FacesAPIError(503, 'm'), 'alice@x'), 'Try again.')
eq('503 hint names the wait', /in 30s/.test(faceRefusalHint(new FacesAPIError(503, 'm', {retryAfter: 30}), 'alice@x')), true)
eq('503 hint: no warm-up', /warm/i.test(faceRefusalHint(new FacesAPIError(503, 'm', {retryAfter: 30}), 'alice@x') ?? ''), false)
eq('504 hint: ask again', faceRefusalHint(new FacesAPIError(504, 'm'), 'alice@x'), 'The face did not finish within 300 seconds. Ask again.')
eq('409 nothing compiled: a first source', /^Give it a first source: faces compile:upload testo --file <file>\./.test(faceRefusalHint(new FacesAPIError(409, 'this face has nothing compiled, so it has no reasoning'), 'testo') ?? ''), true)
eq('409 nothing compiled on a formula: each face', faceRefusalHint(new FacesAPIError(409, 'this face has nothing compiled'), '(a | b)@x'), 'Every face in (a | b) needs something compiled: faces compile:upload <alias> --file <file> for each.')
eq('409 recompile on a formula: no face:sources of a formula', /face:sources/.test(faceRefusalHint(new FacesAPIError(409, 'compiled before reasoning launched'), '(a & b)@x') ?? ''), false)
eq('422 empty_composite: says the result is empty', /Nothing is left once the formula is applied/.test(refusalGuidance(422, 'empty_composite', 'the intersection between these two faces is null') ?? ''), true)
eq('422 no hint', faceRefusalHint(new FacesAPIError(422, 'm'), 'alice@x'), undefined)


// --- a cause the caller writes ------------------------------------------------
eq('cause given', resolveCause('I will not sign.', undefined), 'I will not sign.')
eq('cause blank is not sent', resolveCause('   \n', undefined), undefined)
eq('no cause', resolveCause(undefined, undefined), undefined)
eq('cause from a file', resolveCause(undefined, new URL(import.meta.url).pathname).startsWith('/**'), true)
eq('cause file missing', (() => { try { resolveCause(undefined, '/nonexistent/x'); return 'no throw' } catch (e) { return e.message } })(), 'File not found: /nonexistent/x')


// --- a chat aimed at a decision model ------------------------------------------
eq('decision model refused for chat', decisionModelError('jev-latest'), 'jev-latest is a decision model, not a chat model; use `faces decide`')
eq('decision model match ignores case', /decision model/.test(decisionModelError('Clef-Flash') || ''), true)
eq('chat model passes', decisionModelError('gpt-5.4'), undefined)
eq('no model passes', decisionModelError(undefined), undefined)

// --- the per-minute rate limit: one retry after Retry-After, never a loop -----
const RL = 'Rate limit: 60 requests per minute on the connect plan. Retry in 15s.'
eq('rate limit: waits the header', rateLimitWait(15, JSON.stringify({detail: RL})), 15)
eq('rate limit: no header, no retry', rateLimitWait(undefined, JSON.stringify({detail: RL})), undefined)
eq('rate limit: past a minute, no retry', rateLimitWait(3600, JSON.stringify({detail: RL})), undefined)
eq('allowance 429 is not retried', rateLimitWait(10, JSON.stringify({detail: 'Your 5-hour allowance is used.'})), undefined)
eq('rate limit guidance', /api\.faces\.sh\/v1\/rates/.test(refusalGuidance(429, undefined, RL) ?? ''), true)
eq('allowance guidance unchanged', /api_fallback true/.test(refusalGuidance(429, undefined, 'allowance used') ?? ''), true)
eq('free oauth-only guidance', /drop --oauth-only/.test(refusalGuidance(422, 'oauth_only_unavailable', 'm') ?? ''), true)

async function rateLimited() {
  let replies = []
  let calls = 0
  const srv = http.createServer((req, res) => {
    calls++
    const [status, headers, body] = replies.length > 1 ? replies.shift() : replies[0]
    res.writeHead(status, {'content-type': 'application/json', ...headers})
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  await new Promise((r) => srv.listen(0, r))
  const client = new FacesClient(`http://127.0.0.1:${srv.address().port}`, undefined, 'sk-check')
  const err = async (fn) => {
    try {
      await fn()
      return undefined
    } catch (e) {
      return e
    }
  }
  try {
    const limited = [429, {'retry-after': '0'}, {detail: RL}]
    replies = [limited, [200, {}, {ok: true}]]
    calls = 0
    eq('429 then 200: retried once', await client.post('/v1/x', {body: {}}), {ok: true})
    eq('429 then 200: two calls', calls, 2)

    replies = [limited]
    calls = 0
    const twice = await err(() => client.post('/v1/x', {body: {}}))
    eq('429 twice: refused with the message', twice?.statusCode, 429)
    eq('429 twice: one retry only', calls, 2)
    eq('429 twice: message kept', twice?.message.startsWith(RL), true)

    replies = [[429, {}, {detail: RL}]]
    calls = 0
    await err(() => client.get('/v1/x'))
    eq('429 without Retry-After: no retry', calls, 1)

    replies = [[429, {'retry-after': '0'}, {detail: 'Your monthly allowance is used.'}]]
    calls = 0
    await err(() => client.get('/v1/x'))
    eq('allowance 429: no retry', calls, 1)

    // A refusal with its code beside a plain sentence keeps the code.
    replies = [[422, {}, {detail: 'OAuth-only is not available on Free.', error_code: 'oauth_only_unavailable'}]]
    const free = await err(() => client.post('/v1/chat/completions', {body: {}}))
    eq('free oauth-only: code kept', free?.errorCode, 'oauth_only_unavailable')
    eq('free oauth-only: sentence first', free?.message.startsWith('OAuth-only is not available on Free.'), true)

    // A held decision: 200 and spaces first, then the JSON.
    replies = [[200, {'x-faces-held': '1'}, '      \n   ' + JSON.stringify({answers: {a: {yes: 0.7}}})]]
    eq('held body parses past the spaces', await client.post('/v1/systemone', {body: {}}), {answers: {a: {yes: 0.7}}})
  } finally {
    srv.close()
  }
}
await rateLimited()

// --- a held decision that failed arrives as a 200 carrying the refusal ---------
const heldFail = heldDecisionError({detail: 'The decision model timed out.', error: {type: 'timeout', status: 504}})
eq('held failure: status', heldFail?.statusCode, 504)
eq('held failure: message', heldFail?.message, 'The decision model timed out.')
eq('held failure: code', heldFail?.errorCode, 'timeout')
eq('held failure: no status is a 502', heldDecisionError({error: {message: 'boom'}})?.statusCode, 502)
eq('held failure: message from error', heldDecisionError({error: {message: 'boom'}})?.message, 'boom')
eq('an answer is not a failure', heldDecisionError({answers: {a: {}}, cause: 'x'}), undefined)
eq('a cause alone is not a failure', heldDecisionError({cause: 'x'}), undefined)
eq('no error is not a failure', heldDecisionError({}), undefined)

// --- polling a compile on status, against a scripted server -------------------
async function polling() {
  let script = []
  let paths = []
  const srv = http.createServer((req, res) => {
    paths.push(req.url)
    const body = script.length > 1 ? script.shift() : script[0]
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify(body))
  })
  await new Promise((r) => srv.listen(0, r))
  const client = new FacesClient(`http://127.0.0.1:${srv.address().port}`, undefined, 'sk-check')
  const run = async (steps, opts = {}) => {
    script = steps
    paths = []
    const seen = []
    try {
      const out = await pollCompileProgress(client, 'd1', {intervalMs: 1, timeoutMs: 2000, onProgress: (p) => seen.push(p.status), ...opts})
      return {out, seen}
    } catch (err) {
      return {error: err.message, seen}
    }
  }
  try {
    const ok = await run([
      {status: 'queued', progress: 0},
      {status: 'queued', progress: 0},
      {status: 'compiling', progress: 0.5},
      {status: 'compiled', progress: 1, content: 'x'},
    ])
    eq('poll: queued once, then compiling, then done', ok.seen, ['queued', 'compiling', 'compiled'])
    eq('poll: re-reads the full source at the end', paths.at(-1), '/v1/compile/documents/d1')
    eq('poll: ticks use status_only', paths[0], '/v1/compile/documents/d1?status_only=true')
    const failedRun = await run([{status: 'failed', progress: 0.3, finishing: false, stall_reason: 'model refused'}])
    eq('poll: failed ends it with the reason', /model refused/.test(failedRun.error ?? ''), true)
    const retried = await run([
      {status: 'failed', progress: 0.3, finishing: true},
      {status: 'compiled', progress: 1},
    ], {fullOnFinish: false})
    eq('poll: a failure still being retried is waited out', retried.out?.status, 'compiled')
    const paused = await run([{status: 'paused', progress: 0.4}])
    eq('poll: paused ends it', /paused/.test(paused.error ?? ''), true)
    const newer = await run([{status: 'warming_up', progress: 0.1}, {status: 'compiled', progress: 1}], {fullOnFinish: false})
    eq('poll: an unknown status keeps waiting', newer.seen[0], 'compiling')
    const later = new Date(Date.now() + 60_000).toISOString()
    const waits = await run([
      ...Array.from({length: 40}, () => ({status: 'queued', progress: 0, starts_at: later})),
      {status: 'compiled', progress: 1},
    ], {timeoutMs: 1, startsAt: later, fullOnFinish: false})
    eq('poll: a scheduled start is waited for, not timed out', waits.out?.status, 'compiled')
    const old = await run([{prepare_status: 'synced', parts_total: 2, parts_completed: 2}], {timeoutMs: 30})
    eq('poll: the old fields are not read', /timed out/.test(old.error ?? ''), true)

    script = [{status: 'compiling', progress: 0.2}, {status: 'paused', progress: 0.2}]
    eq('pause: lands', await pollUntilPaused(client, 'd1', {intervalMs: 1, timeoutMs: 2000}), 'paused')
    script = [{status: 'compiled', progress: 1}]
    eq('pause: finished first', await pollUntilPaused(client, 'd1', {intervalMs: 1, timeoutMs: 2000}), 'compiled')
  } finally {
    srv.close()
  }
}
await polling()

// --- ids from input stay one path segment ------------------------------------
// A raw id could climb out of its route: `../../faces/x` turned a document
// delete into a face delete.
eq('seg: a slash stays inside the segment', seg('../../faces/x'), '..%2F..%2Ffaces%2Fx')
eq('seg: owner:alias', seg('head:socrates'), 'head%3Asocrates')
eq('seg: query and fragment characters', seg('a?b#c&d'), 'a%3Fb%23c%26d')
for (const bad of ['', '.', '..']) {
  let threw = false
  try { seg(bad) } catch { threw = true }
  eq(`seg: refuses ${JSON.stringify(bad)}`, threw, true)
}

async function pathGuard() {
  const paths = []
  const srv = http.createServer((req, res) => {
    paths.push(req.url)
    res.writeHead(200, {'content-type': 'application/json'})
    res.end('{}')
  })
  await new Promise((r) => srv.listen(0, r))
  const client = new FacesClient(`http://127.0.0.1:${srv.address().port}`, undefined, 'sk-check')
  const refused = async (p) => {
    try { await client.delete(p); return false } catch (err) { return /would be rewritten/.test(err.message) }
  }
  try {
    await client.delete(`/v1/compile/documents/${seg('../../faces/x')}`)
    eq('guard: an encoded id reaches its own route', paths.at(-1), '/v1/compile/documents/..%2F..%2Ffaces%2Fx')
    eq('guard: a raw dot segment is refused', await refused('/v1/compile/documents/../../faces/x'), true)
    eq('guard: an encoded dot segment is refused', await refused('/v1/compile/documents/%2e%2e/%2E%2E/faces/x'), true)
    eq('guard: a single dot is refused', await refused('/v1/faces/./x'), true)
    eq('guard: nothing refused reached the server', paths.length, 1)
    await client.get('/v1/faces?q=../x')
    eq('guard: dots in a query are left alone', paths.at(-1), '/v1/faces?q=../x')
  } finally {
    srv.close()
  }
}
await pathGuard()

// A thread id names a file under ~/.faces/threads, so it must not name any other.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  fs.mkdirSync(path.join(home, '.faces'))
  const config = path.join(home, '.faces', 'config.json')
  fs.writeFileSync(config, '{}')
  const run = spawnSync(process.execPath, ['bin/run.js', 'chat:thread', '--id', '../config', '--delete'], {env: {...process.env, HOME: home}, encoding: 'utf8'})
  eq('thread id: a path is refused', run.status !== 0, true)
  eq('thread id: the config survives', fs.existsSync(config), true)
  fs.rmSync(home, {recursive: true, force: true})
}

// Catalog folders are deleted recursively, so a name must stay inside its parent.
{
  const refuses = (name) => { try { childPath('/base/catalog', name); return false } catch { return true } }
  eq('childPath: a plain name', childPath('/base/catalog', 'alice'), '/base/catalog/alice')
  for (const bad of ['', '.', '..', '../x', 'a/b', '../../.ssh', '/etc']) eq(`childPath: refuses ${JSON.stringify(bad)}`, refuses(bad), true)
}


// --- the out-of-date hint only claims an update helps when one exists ---------
eq('versions: equal', compareVersions('1.20.1', '1.20.1'), 0)
eq('versions: patch behind', compareVersions('1.20.0', '1.20.1'), -1)
eq('versions: numeric, not text', compareVersions('1.10.0', '1.9.9'), 1)
eq('hint: on the latest it is a bug', /looks like a Faces CLI bug/.test(outOfDateHint(CLI_VERSION)), true)
eq('hint: on the latest it never says update', /npm install/.test(outOfDateHint(CLI_VERSION)), false)
eq('hint: behind names the latest', outOfDateHint('99.0.0').includes('the latest is 99.0.0'), true)
eq('hint: unknown keeps "may be"', /may be out of date/.test(outOfDateHint(null)), true)

// --- a typed budget is a dollar amount or nothing ----------------------------
{
  const fail = (m) => { throw new Error(m) }
  const ok = (raw) => { try { return parseBudget(raw, fail) } catch { return 'refused' } }
  eq('budget: whole dollars', ok('5'), 5)
  eq('budget: cents', ok('0.50'), 0.5)
  eq('budget: a leading $', ok('$2'), 2)
  for (const bad of ['1abc', '1e6', 'abc', 'NaN', 'Infinity', '-1', '1.005', '']) eq(`budget: refuses ${JSON.stringify(bad)}`, ok(bad), 'refused')
}

// --- key limits go out under the API's field names ---------------------------
async function keyFields() {
  const bodies = []
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      bodies.push(JSON.parse(b || '{}'))
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({id: 'k1', name: 'n', key: 'sk-x'}))
    })
  })
  await new Promise((r) => srv.listen(0, r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  const env = {...process.env, HOME: home, FACES_BASE_URL: `http://127.0.0.1:${srv.address().port}`, FACES_TOKEN: 'jwt-check'}
  const run = (args) => new Promise((r) => execFile(process.execPath, ['bin/run.js', ...args], {env}, () => r()))
  try {
    await run(['keys:create', '--name', 'n', '--no-save', '--expires-days', '7', '--budget', '2.5', '--face', 'alice', '--model', 'gpt-5-mini', '--json'])
    eq('keys:create sends the API field names', bodies[0], {name: 'n', expires_in_days: 7, budget_usd: 2.5, allowed_face_ids: ['alice'], allowed_llm_models: ['gpt-5-mini']})
    await run(['keys:update', 'k1', '--budget', '1', '--json'])
    eq('keys:update sends budget_usd', bodies[1], {budget_usd: 1})
  } finally {
    srv.close()
    fs.rmSync(home, {recursive: true, force: true})
  }
}
await keyFields()

// --- commands the API takes only from a signed-in session send the login -----
// With an API key saved, the CLI sends the key by default. The API refuses keys
// on sharing, publishing, deleting a face, linked accounts and billing changes,
// so those commands must send the saved login instead.
async function loginOnlyCommands() {
  const seen = []
  const srv = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      seen.push({auth: req.headers.authorization, call: `${req.method} ${req.url.split('?')[0]}`})
      const send = (body) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(body)) }
      if (req.method === 'GET' && req.url.startsWith('/v1/faces/alice')) return send({id: 'f1', username: 'alice', shared_with: ['bob']})
      if (req.method === 'GET' && req.url === '/v1/billing/subscription') return send({plan: 'pro', status: 'active', cancel_at_period_end: true})
      if (req.url === '/v1/oauth') return send([])
      send({})
    })
  })
  await new Promise((r) => srv.listen(0, r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  const env = {...process.env, HOME: home, FACES_BASE_URL: `http://127.0.0.1:${srv.address().port}`, FACES_TOKEN: 'jwt-check', FACES_API_KEY: 'sk-faces-check'}
  const run = (args) => new Promise((r) => execFile(process.execPath, ['bin/run.js', ...args], {env}, () => r()))
  try {
    for (const args of [
      ['face:publish', 'alice', '--yes', '--json'], ['face:unpublish', 'alice', '--json'],
      ['face:share', 'alice', '--add', 'carol', '--yes', '--json'], ['face:unshare', 'alice', '--from', 'bob', '--yes', '--json'],
      ['face:delete', 'alice', '--yes', '--json'], ['auth:connections', '--json'],
      ['billing:topup', '--amount', '10', '--yes', '--json'], ['billing:card:remove', 'pm_1', '--yes', '--json'],
      ['billing:card-setup', '--json'], ['billing:card:default', 'pm_1', '--json'],
      ['billing:subscription:activate', '--json'],
    ]) await run(args)
    const loginOnly = seen.filter((s) => s.call !== 'GET /auth/me' && (s.call.startsWith('GET /v1/oauth') || !s.call.startsWith('GET ')))
    eq('login-only commands: each one reached the API', [...new Set(loginOnly.map((s) => s.call))].sort(), [
      'DELETE /v1/billing/payment-methods/pm_1', 'DELETE /v1/faces/alice', 'GET /v1/oauth',
      'PATCH /v1/faces/alice/publish', 'PATCH /v1/faces/alice/share',
      'POST /v1/billing/card-setup', 'POST /v1/billing/payment-methods/pm_1/default',
      'POST /v1/billing/subscription/reactivate', 'POST /v1/billing/topup',
    ])
    eq('login-only commands: none sent the API key', loginOnly.filter((s) => s.auth !== 'Bearer jwt-check').map((s) => s.call), [])
  } finally {
    srv.close()
    fs.rmSync(home, {recursive: true, force: true})
  }
}
await loginOnlyCommands()

// --- refusals and confirmations, through the real commands -------------------
async function errorsAndConfirmations() {
  const seen = []
  const makeBodies = []
  const styleBodies = []
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const send = (status, body) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)) }
    if (req.url.startsWith('/v1/faces/ghost')) return send(404, {detail: "Face 'ghost' not found"})
    if (req.url.includes('/started/make')) return send(409, {detail: {message: "This document's compile has already started, so it can no longer be rushed.", error_code: 'compile_already_started'}})
    if (req.url.startsWith('/v1/compile/documents?alias=')) return send(200, [{document_id: 'd1', label: 'Essay', medium: 'essay', kind: 'essay', synced: true}])
    if (req.url.startsWith('/v1/compile/threads?alias=')) return send(200, [])
    if (req.url === '/v1/style/builds' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        styleBodies.push(JSON.parse(body || '{}'))
        if (JSON.parse(body || '{}').oauth_only) return send(409, {detail: {error_code: 'chatgpt_not_linked', message: 'oauth_only builds only through a linked ChatGPT account.'}})
        send(402, {detail: {message: 'This style build is paid from credit.', error_code: 'insufficient_credit_for_style_build', estimated_usd: 3.4, balance_usd: 1.25}})
      })
      return
    }
    if (req.url.includes('/rushy/make')) return send(402, {detail: {message: 'The rush adds $1.25, paid from credit.', error_code: 'insufficient_credit_for_rush', rush_premium_usd: 1.25}})
    if (req.url.includes('/sched/make')) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        makeBodies.push(body)
        send(202, {document_id: 'sched', status: 'queued', progress: 0, starts_at: new Date(Date.now() + 40 * 60_000).toISOString(), rush: false})
      })
      return
    }
    if (req.url.includes('/make')) return send(409, {detail: 'Already compiled. Nothing was charged.', error_code: 'already_compiled'})
    if (req.url.startsWith('/v1/billing/subscription') && req.method === 'GET') return send(200, {plan: 'pro', status: 'active'})
    send(200, {})
  })
  await new Promise((r) => srv.listen(0, r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  const base = {...process.env, HOME: home, FACES_BASE_URL: `http://127.0.0.1:${srv.address().port}`}
  const run = (args, env = {...base, FACES_API_KEY: 'sk-check'}) => new Promise((r) => {
    const child = execFile(process.execPath, ['bin/run.js', ...args], {env}, (err, stdout, stderr) => r({code: err ? err.code : 0, stdout, stderr}))
    child.stdin.end()
  })
  const json = (out) => { try { return JSON.parse(out.stdout) } catch { return undefined } }
  try {
    seen.length = 0
    let r = await run(['face:delete', 'alice', '--json'])
    eq('confirm: --json without --yes is refused', [r.code, /Re-run with --yes/.test(json(r)?.error?.message ?? '')], [2, true])
    r = await run(['face:delete', 'alice'])
    eq('confirm: no terminal is refused, not a hang', [r.code, /Re-run with --yes/.test(r.stderr)], [2, true])
    r = await run(['billing:subscription:plan', 'connect', '--json'])
    eq('confirm: a plan switch under --json asks for --yes', [r.code, /Re-run with --yes/.test(json(r)?.error?.message ?? '')], [2, true])
    r = await run(['billing:topup', '--amount', '5', '--json'])
    eq('confirm: a top-up asks for --yes', r.code, 2)
    r = await run(['compile:doc:delete', 'd1', '--json'])
    eq('confirm: a document delete asks for --yes', r.code, 2)
    eq('confirm: nothing refused was sent', seen.filter((l) => !l.startsWith('GET')), [])

    r = await run(['face:get', 'ghost', '--json'])
    const text = await run(['face:get', 'ghost'])
    eq('json error: carries the HTTP status', json(r)?.error?.status, 404)
    eq('json error: the same exit code as text', r.code, text.code)
    r = await run(['compile:doc:make', 'd1', '--json'])
    eq('json error: carries error_code', json(r)?.error?.error_code, 'already_compiled')
    r = await run(['compile:doc:make', 'rushy', '--rush', '--json'])
    eq('rush 402: carries error_code and the premium', [json(r)?.error?.error_code, json(r)?.error?.rush_premium_usd], ['insufficient_credit_for_rush', 1.25])
    r = await run(['compile:doc:make', 'rushy', '--rush'])
    eq('rush 402: text names the premium and both ways on', [/Rush premium: \$1\.25/.test(r.stderr), /without --rush/.test(r.stderr), /billing:topup/.test(r.stderr)], [true, true, true])
    r = await run(['compile:doc:make', 'sched', '--no-wait', '--json'])
    eq('scheduled: --json carries starts_at', typeof json(r)?.starts_at, 'string')
    eq('scheduled: no --rush sends no body', makeBodies.at(-1), '')
    r = await run(['compile:doc:make', 'sched', '--no-wait', '--rush'])
    eq('scheduled: text says when it starts', /Scheduled start: .* \(in (39|40) min\)/.test(r.stderr), true)
    eq('scheduled: --rush is sent', makeBodies.at(-1), '{"rush":true}')
    r = await run(['compile:doc:make', 'started', '--rush'])
    eq('rush too late: text says it already started', /--rush no longer applies/.test(r.stderr), true)
    r = await run(['compile:doc:make', 'started', '--rush', '--json'])
    eq('rush too late: --json carries the code', json(r)?.error?.error_code, 'compile_already_started')
    r = await run(['style:make', 'alice', '--source', 'd1'])
    eq('style: no --allow-paid sends oauth_only', styleBodies.at(-1)?.oauth_only, true)
    eq('style 409: link ChatGPT or --allow-paid', [/auth:connect openai/.test(r.stderr), /--allow-paid/.test(r.stderr)], [true, true])
    r = await run(['style:make', 'alice', '--source', 'd1', '--allow-paid'])
    eq('style: --allow-paid sends oauth_only false', styleBodies.at(-1)?.oauth_only, false)
    eq('style 402: estimate, balance and top-up', [/up to \$3\.40/.test(r.stderr), /\$1\.25/.test(r.stderr), /billing:topup/.test(r.stderr)], [true, true, true])
    r = await run(['style:make', 'alice', '--source', 'd1', '--allow-paid', '--json'])
    eq('style 402: --json carries the figures', [json(r)?.error?.error_code, json(r)?.error?.estimated_usd, json(r)?.error?.balance_usd], ['insufficient_credit_for_style_build', 3.4, 1.25])
    r = await run(['face:list', '--json'], {...base, FACES_API_KEY: '', FACES_TOKEN: ''})
    eq('json error: no credentials still answers in JSON', /Authentication required/.test(json(r)?.error?.message ?? ''), true)
    r = await run(['face:list', '--json', '--toon'])
    eq('json error: --json with --toon answers in JSON', json(r) !== undefined, true)
  } finally {
    srv.close()
    fs.rmSync(home, {recursive: true, force: true})
  }
}
await errorsAndConfirmations()

// --- saved credentials stay with the API they belong to ----------------------
// Run in a child with its own HOME: config.js reads ~/.faces at import.
async function credentials() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  fs.mkdirSync(path.join(home, '.faces'))
  const cfg = path.join(home, '.faces', 'config.json')
  const probe = (config, base, env = {}) => {
    fs.writeFileSync(cfg, typeof config === 'string' ? config : JSON.stringify(config))
    const code = `import('${new URL('../dist/config.js', import.meta.url).href}').then((c) => {
      try { const r = c.resolveCredentials({}, ${JSON.stringify(base)}); console.log(JSON.stringify({token: r.token ?? null, apiKey: r.apiKey ?? null, withheld: Boolean(r.withheld)})) }
      catch (e) { console.log(JSON.stringify({error: e.message})) } })`
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {env: {...process.env, HOME: home, FACES_TOKEN: '', FACES_API_KEY: '', ...env}, encoding: 'utf8'})
    return JSON.parse(out.stdout.trim().split('\n').at(-1))
  }
  try {
    const saved = {token: 'jwt-saved', credentials_base_url: 'https://api.faces.sh'}
    eq('creds: sent to their own API', probe(saved, 'https://api.faces.sh'), {token: 'jwt-saved', apiKey: null, withheld: false})
    eq('creds: withheld from another host', probe(saved, 'https://httpbin.org/anything'), {token: null, apiKey: null, withheld: true})
    eq('creds: an older config belongs to its base_url', probe({api_key: 'sk-faces-x', base_url: 'https://staging.faces.sh'}, 'https://staging.faces.sh'), {token: null, apiKey: 'sk-faces-x', withheld: false})
    eq('creds: an older config with no base_url belongs to the default', probe({token: 't'}, 'https://example.com').withheld, true)
    eq('creds: an explicit key is always used', probe(saved, 'https://example.com', {FACES_API_KEY: 'sk-faces-env'}).apiKey, 'sk-faces-env')
    eq('creds: never over plain http to another machine', /plain http/.test(probe(saved, 'http://example.com', {FACES_API_KEY: 'sk-faces-env'}).error ?? ''), true)
    eq('creds: plain http to localhost is fine', probe({token: 't', credentials_base_url: 'http://localhost:8000'}, 'http://localhost:8000').token, 't')
    // A corrupt config is kept, not overwritten.
    fs.writeFileSync(cfg, '{not json')
    spawnSync(process.execPath, ['bin/run.js', 'config:set', 'catalog', 'false'], {env: {...process.env, HOME: home}, encoding: 'utf8'})
    eq('config: a corrupt file is backed up before a write', fs.readdirSync(path.join(home, '.faces')).some((f) => f.startsWith('config.json.corrupt-')), true)
    const typo = spawnSync(process.execPath, ['bin/run.js', 'config:set', 'apikey', 'x'], {env: {...process.env, HOME: home}, encoding: 'utf8'})
    eq('config:set: a typo is refused and named', [typo.status !== 0, /Did you mean api_key/.test(typo.stderr)], [true, true])
    const url = spawnSync(process.execPath, ['bin/run.js', 'config:set', 'base_url', 'not-a-url'], {env: {...process.env, HOME: home}, encoding: 'utf8'})
    eq('config:set: base_url must be a URL', url.status !== 0, true)
  } finally {
    fs.rmSync(home, {recursive: true, force: true})
  }
}
await credentials()

// --- a server that is not the Faces API is named as such ---------------------
async function notFaces() {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v1/')) { res.writeHead(404, {'content-type': 'application/json'}); return res.end('{"detail":"Not Found"}') }
    res.writeHead(404, {'content-type': 'text/html'}); res.end('<html>nope</html>')
  })
  await new Promise((r) => srv.listen(0, r))
  const origin = `http://127.0.0.1:${srv.address().port}`
  const message = async (base) => { try { await new FacesClient(base, undefined, 'sk-check').get('/v1/faces'); return '' } catch (e) { return e.message } }
  try {
    const html = await message(origin)
    eq('not faces: says so', /did not answer like the Faces API/.test(html), true)
    eq('not faces: no update hint', /out of date/.test(html), false)
    eq('base path: names the fix', /routes already include it/.test(await message(`${origin}/api`)), true)
    const closed = http.createServer()
    await new Promise((r) => closed.listen(0, r))
    const freed = closed.address().port
    await new Promise((r) => closed.close(r))
    const down = await message(`http://127.0.0.1:${freed}`)
    eq('unreachable: names the cause and the base URL', [/ECONNREFUSED/.test(down), /config:show/.test(down)], [true, true])
  } finally {
    srv.close()
  }
}
await notFaces()

// --- a stream with no events in it is the error it carries -------------------
async function bareStream() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8'})
    res.end(': keep-alive\n\n{\n  "error": {\n    "message": "Invalid \'temperature\'",\n    "type": "invalid_request_error",\n    "code": null\n  }\n}\n')
  })
  await new Promise((r) => srv.listen(0, r))
  const client = new FacesClient(`http://127.0.0.1:${srv.address().port}`, undefined, 'sk-check')
  let caught
  try {
    for await (const _ of client.stream('/v1/chat/completions', {})) { /* drain */ }
  } catch (err) {
    caught = err
  }
  eq('bare stream: thrown as a refusal', [caught instanceof FacesAPIError, caught?.statusCode, caught?.message], [true, 400, "Invalid 'temperature'"])
  srv.close()
}
await bareStream()
{
  const fail = (m) => { throw new Error(m) }
  const t = (raw) => { try { return parseTemperature(raw, fail) } catch { return 'refused' } }
  eq('temperature: in range', [t('0'), t('0.7'), t('2')], [0, 0.7, 2])
  eq('temperature: out of range or not a number', [t('-1'), t('2.1'), t('abc'), t('')], ['refused', 'refused', 'refused', 'refused'])
}

// --- a refused saved key falls back to the saved login; a chosen one does not
async function keyFallback() {
  const srv = http.createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer jwt-ok'
    res.writeHead(ok ? 200 : 401, {'content-type': 'application/json'})
    res.end(ok ? '{"data": []}' : '{"detail": "Invalid or expired credentials"}')
  })
  await new Promise((r) => srv.listen(0, r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const quiet = process.stderr.write.bind(process.stderr)
  process.stderr.write = () => true
  try {
    const saved = new FacesClient(base, 'jwt-ok', 'sk-faces-dead', undefined, true)
    eq('fallback: a dead saved key uses the login', (await saved.get('/v1/faces').then(() => 'ok', (e) => e.statusCode)), 'ok')
    const chosen = new FacesClient(base, 'jwt-ok', 'sk-faces-dead', undefined, false)
    eq('fallback: a key chosen for the run does not', (await chosen.get('/v1/faces').then(() => 'ok', (e) => e.statusCode)), 401)
  } finally {
    process.stderr.write = quiet
    srv.close()
  }
}
await keyFallback()

// --- catalog files keep what they did not write, and never stack blocks ------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  const code = `
    const {CatalogService} = await import('${new URL('../dist/catalog.js', import.meta.url).href}')
    const {GroupCatalogService, stripFrontmatter} = await import('${new URL('../dist/group-catalog.js', import.meta.url).href}')
    const fs = await import('node:fs'); const path = await import('node:path'); const os = await import('node:os')
    const face = path.join(os.homedir(), '.faces', 'catalog', 'ada', 'FACE.md')
    fs.mkdirSync(path.dirname(face), {recursive: true})
    fs.writeFileSync(face, '---\\nrole: subject\\nsource_type: letters\\nsources_compiled:\\n  - a.pdf\\n  - b.pdf\\n---\\n# Ada recipe\\n')
    new CatalogService().writeFace({name: 'Ada', alias: 'ada', component_counts: [1, 2], compile_tokens_synced: 0})
    new CatalogService().writeFace({name: 'Ada', alias: 'ada', component_counts: [1, 2], compile_tokens_synced: 0})
    const team = path.join(os.homedir(), '.faces', 'teams', 'panel', 'TEAM.md')
    fs.mkdirSync(path.dirname(team), {recursive: true})
    fs.writeFileSync(team, '---\\nid: t1\\nname: Panel\\nmembers: [aa-uuid]\\n---\\n---\\nname: Panel\\nmembers: [ada, bob]\\nmax_rounds: 3\\n---\\nflowchart TD\\n')
    const tc = new GroupCatalogService()
    tc.writeGroup('panel', {id: 't1', name: 'Panel', members: ['ada', 'bob']}, '---\\nname: Panel\\n---\\nflowchart TD\\n')
    console.log(JSON.stringify({face: fs.readFileSync(face, 'utf8'), team: fs.readFileSync(team, 'utf8'), strip: stripFrontmatter('---\\na: 1\\n---\\n---\\nb: 2\\n---\\nbody\\n'), byId: tc.findById('t1')}))`
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {env: {...process.env, HOME: home}, encoding: 'utf8'})
  const r = JSON.parse(out.stdout.trim().split('\n').at(-1))
  eq('FACE.md: one frontmatter block after two writes', (r.face.match(/^---$/gm) ?? []).length, 2)
  eq('FACE.md: recipe keys and list items kept', [/role: subject/.test(r.face), /  - b\.pdf/.test(r.face), /# Ada recipe/.test(r.face)], [true, true, true])
  eq('FACE.md: compiled_tokens written at 0', /compiled_tokens: 0/.test(r.face), true)
  eq('TEAM.md: stacked blocks collapse to one', (r.team.match(/^---$/gm) ?? []).length, 2)
  eq('TEAM.md: a skill key survives', /max_rounds: 3/.test(r.team), true)
  eq('TEAM.md: the protocol keeps no frontmatter', r.team.trim().endsWith('---\nflowchart TD'), true)
  eq('stripFrontmatter: every leading block', r.strip, 'body\n')
  eq('group: found by id', r.byId, 'panel')
  fs.rmSync(home, {recursive: true, force: true})
}

// --- a failed style job is a failed wait --------------------------------------
async function failedStyleJob() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify(req.url.startsWith('/v1/oauth') ? [] : {job_id: 'j1', status: 'failed', error: 'CHATGPT_AUTH: sign-in expired'}))
  })
  await new Promise((r) => srv.listen(0, r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  const env = {...process.env, HOME: home, FACES_BASE_URL: `http://127.0.0.1:${srv.address().port}`, FACES_TOKEN: 'jwt-check'}
  const run = (args) => new Promise((r) => execFile(process.execPath, ['bin/run.js', ...args], {env}, (err, stdout) => r({code: err ? err.code : 0, stdout})))
  try {
    const text = await run(['style:status', 'j1'])
    eq('style status: a failed job exits 1', text.code, 1)
    eq('style status: says nothing is linked', /No ChatGPT account is linked/.test(text.stdout), true)
    eq('style status: --json exits 1 too', (await run(['style:status', 'j1', '--json'])).code, 1)
  } finally {
    srv.close()
    fs.rmSync(home, {recursive: true, force: true})
  }
}
await failedStyleJob()

// --- groups, and the new package's clean break: the old names are gone ------

async function groupNames() {
  const hits = []
  const GID = '11111111-2222-3333-4444-555555555555'
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}${body ? ' ' + body : ''}`)
      res.writeHead(200, {'content-type': 'application/json'})
      if (req.url.startsWith('/v1/me/groups')) return res.end(JSON.stringify({data: [{id: GID, name: 'Panel', kind: 'group', member_count: 2}]}))
      if (req.url.endsWith('/tags')) return res.end(JSON.stringify({tags: ['x']}))
      if (req.url.startsWith('/v1/faces?') || req.url.startsWith('/v1/faces/?')) return res.end(JSON.stringify({data: [], has_more: false}))
      res.end(JSON.stringify({ok: true}))
    })
  })
  await new Promise((r) => srv.listen(0, r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  const env = {...process.env, HOME: home, FACES_BASE_URL: `http://127.0.0.1:${srv.address().port}`, FACES_TOKEN: 'jwt-check'}
  const run = (args) => new Promise((r) => execFile(process.execPath, ['bin/run.js', ...args], {env}, (err, stdout, stderr) => r({code: err?.code ?? 0, out: stdout, err: stderr})))
  try {
    let r = await run(['group:list'])
    eq('group:list calls /v1/me/groups', [r.code, hits.at(-1), /Panel/.test(r.out)], [0, 'GET /v1/me/groups', true])
    eq('group:list: no deprecation warning', /deprecated/.test(r.err), false)
    r = await run(['group:tag:list', GID])
    eq('group:tag:list', [r.code, hits.at(-1)], [0, `GET /v1/groups/${GID}/tags`])
    r = await run(['group:members', GID])
    eq('group:members', hits.at(-1), `GET /v1/groups/${GID}/members`)
    r = await run(['face:list', '--group', GID])
    eq('face:list --group sends group_id', [r.code, hits.some((h) => h.includes(`group_id=${GID}`))], [0, true])
    const before = hits.length
    for (const args of [['team:list'], ['team:members', GID], ['face:teams', 'ada', '--group', GID]]) {
      r = await run(args)
      eq(`${args[0]} is gone`, [r.code !== 0, /not found/i.test(r.err)], [true, true])
    }
    for (const args of [['face:list', '--team', GID], ['face:groups', 'ada', '--team', GID], ['models:list', '--codex'], ['chat:chat', 'ada', '--reasoning', 'hi'], ['decide', 'ada', '--reasoning']]) {
      r = await run(args)
      eq(`${args.at(-2) === '--team' ? args[0] + ' --team' : args.find((a) => a.startsWith('--'))} is gone`, [r.code !== 0, /Nonexistent flag/i.test(r.err)], [true, true])
    }
    eq('removed names call nothing', hits.length, before)
    r = await run(['face:list', '--group', 'not-an-id'])
    eq('face:list --group: a bad id names group:list', /--group takes a group id[\s\S]*group:list/.test(r.err), true)
    r = await run(['face:groups', 'ada', '--group', GID])
    eq('face:groups --group', [r.code, hits.at(-1)], [0, `PUT /v1/faces/ada/groups {"group_ids":["${GID}"]}`])
    const help = spawnSync(process.execPath, ['bin/run.js', '--help'], {env, encoding: 'utf8'}).stdout
    eq('help: group topic shown, no team topic', [/\n  group\s/.test(help), /\n  team\s/.test(help)], [true, false])
  } finally {
    srv.close()
    fs.rmSync(home, {recursive: true, force: true})
  }
}
await groupNames()

// --- a backup written before the rename restores its groups -------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  const file = path.join(home, 'old.json')
  fs.writeFileSync(file, JSON.stringify({version: 2, faces: [], teams: [{name: 'Panel', description: null, protocol: null, tags: [], members: []}]}))
  const out = spawnSync(process.execPath, ['bin/run.js', 'catalog:restore', file], {env: {...process.env, HOME: home, FACES_BASE_URL: 'http://127.0.0.1:9', FACES_TOKEN: 'x'}, encoding: 'utf8'})
  eq('restore: an older backup\'s groups are counted', /Groups: 1/.test(out.stdout + out.stderr), true)
  fs.rmSync(home, {recursive: true, force: true})
}

// --- meters never read as spent while some is left ---------------------------
eq('tokens: 6.25M keeps its precision', tokens(6_250_000), '6.25M')
eq('tokens: 2,496,000 is not 2.5M', tokens(2_496_000), '2.49M')
eq('tokens: 999,999 is not 1000k', tokens(999_999), '999.9k')
eq('tokens: 9,950,000 rounds down', tokens(9_950_000), '9.95M')
eq('tokens: 637k', tokens(637_000), '637k')
eq('percent: nearly full is not 100%', percentUsed(637_000, 640_000), '99%')
eq('percent: a little use shows', percentUsed(1, 2_500_000), '<1%')
eq('percent: none', percentUsed(0, 100), '0%')
eq('allowance: an unknown unlimited key', allowanceLines({plan: 'team', allowances: {new_thing: {used: 3, limit: -1}}}).some((l) => /3 used, unlimited/.test(l)), true)

// --- tables, dollars and dates for billing output -----------------------------
eq('usd: zero', usd(0), '$0.00')
eq('usd: cents', usd(0.013268), '$0.0133')
eq('usd: dollars', usd(9.518832), '$9.52')
eq('date: real', isCalendarDate('2026-10-21'), true)
eq('date: no month 13, no Feb 30, no words', [isCalendarDate('2026-13-01'), isCalendarDate('2026-02-30'), isCalendarDate('garbage')], [false, false, false])
eq('table: numbers right-aligned', table(['A', 'N'], [['x', '1'], ['yy', '100']], new Set(['N'])), ['A     N', 'x     1', 'yy  100'])

// --- names that break every listing are refused -------------------------------
eq('name: ordinary', badFaceName('Ada Lovelace'), undefined)
eq('name: too long', /200 or fewer/.test(badFaceName('x'.repeat(5000)) ?? ''), true)
eq('name: a right-to-left override', /text-direction/.test(badFaceName('abc‮def') ?? ''), true)
eq('name: empty', badFaceName('   '), 'The name is empty.')

// --- decide: limits checked before a face is asked ----------------------------
const qs = (n, extra = {}) => Object.fromEntries(Array.from({length: n}, (_, i) => [`q${i}`, {type: 'noul', instructions: 'x', ...extra}]))
eq('questions: 10 with a face is fine', questionsProblem(qs(10), true), undefined)
eq('questions: 11 with a face is refused', /At most 10 questions with a face \(got 11\)/.test(questionsProblem(qs(11), true) ?? ''), true)
eq('questions: 32 with --baseline is fine', questionsProblem(qs(32), false), undefined)
eq('questions: 33 with --baseline is refused', /At most 32/.test(questionsProblem(qs(33), false) ?? ''), true)
eq('choice: one option is refused', /has 1 option/.test(questionsProblem({c: {type: 'choice', criteria: {a: null}}}, true) ?? ''), true)
eq('choice: 255 options is fine', questionsProblem({c: {type: 'choice', criteria: Object.fromEntries(Array.from({length: 255}, (_, i) => [`o${i}`, null]))}}, false), undefined)

// --- decide --format openai ------------------------------------------------------
const oaQs = {go: {type: 'noul', instructions: 'Go?'}, why: {type: 'choice', instructions: 'Why?', criteria: {laws: 'the agreement', friends: null}}, mood: {type: 'score', instructions: 'Mood?', criteria: ['calm', 'furious']}}
const oa = toOpenAIDecision('alice@clef', 'A situation.', oaQs)
eq('openai: input is the state', oa.input, 'A situation.')
eq('openai: noul is a predicate', oa.questions[0], {type: 'predicate', name: 'go', instructions: 'Go?'})
eq('openai: choices keep descriptions, omit null', oa.questions[1].choices, [{value: 'laws', description: 'the agreement'}, {value: 'friends'}])
eq('openai: levels are labels', oa.questions[2].levels, [{label: 'calm'}, {label: 'furious'}])
eq('openai: no questions, no field', 'questions' in toOpenAIDecision('alice', 'x', undefined), false)
let threwNoul = false
try { toOpenAIDecision('m', 'x', {n: {type: 'noul', instructions: 'i', criteria: {true: 'a', false: 'b'}}}) } catch { threwNoul = true }
eq('openai: noul descriptions refused', threwNoul, true)
const back = fromOpenAIAnswers([
  {type: 'predicate', name: 'go', probability: 0.08},
  {type: 'choice', name: 'why', choice: 'laws', probabilities: [{value: 'laws', probability: 0.99}, {value: 'friends', probability: 0.01}], confidence: 0.98},
  {type: 'score', name: 'mood', score: 0.4, probabilities: [{probability: 0.6}, {probability: 0.4}], confidence: 0.5},
], oaQs)
eq('openai answers: predicate prints as a noul', back.go, {type: 'noul', noul: 0.08})
eq('openai answers: choice probabilities by value', back.why.probabilities, {laws: 0.99, friends: 0.01})
eq('openai answers: score legend from the sent levels', back.mood.legend, {0: 'calm', 1: 'furious'})

// --- refusals, error codes and duplicate top-ups --------------------------------
eq('402 no card: no repeated sentence', refusalGuidance(402, undefined, 'No payment method on file. Add a card first.'), 'Add a card with: faces billing:card-setup')
eq('failure: error_code wins over the text', /No ChatGPT account is linked/.test(jobFailureMessage('sign-in expired', false, 'chatgpt_auth')), true)
eq('failure: no code falls back to the text', /most likely expired/.test(jobFailureMessage('CHATGPT_AUTH: x', true, null)), true)

async function duplicateTopup() {
  const srv = http.createServer((req, res) => {
    res.writeHead(409, {'content-type': 'application/json'})
    res.end(JSON.stringify({detail: {error_code: 'duplicate_topup', message: 'You topped up $5.00 a minute ago.', repeat_with: {allow_duplicate: true}}}))
  })
  await new Promise((r) => srv.listen(0, r))
  const client = new FacesClient(`http://127.0.0.1:${srv.address().port}`, undefined, 'sk-check')
  try {
    await client.post('/v1/billing/topup', {body: {amount_usd: 5}})
    eq('duplicate top-up: refused', false, true)
  } catch (err) {
    eq('duplicate top-up: code from the detail object', err.errorCode, 'duplicate_topup')
    eq('duplicate top-up: the message, not the object', err.message, 'You topped up $5.00 a minute ago.')
  } finally {
    srv.close()
  }
}
await duplicateTopup()

// --- --tool names: shape only, since the API keeps no list ---------------------
eq('tool: ordinary', badToolNames(['web_search', 'code-interpreter']), undefined)
eq('tool: a space is a typo', /not a tool name/.test(badToolNames(['web search']) ?? ''), true)
eq('tool: empty', badToolNames(['  ']), 'A --tool name is empty.')
eq('tool: twice', badToolNames(['a', ' a']), "'a' is given twice.")

eq('compile cost: small says nothing', compileCostNote(20_000, 25), undefined)
eq('compile cost: large names the price', /about \$2\.50 on credits \(\$25 per million/.test(compileCostNote(100_000, 25) ?? ''), true)

// --- fidelity: a whole run through the real commands ---------------------------
async function fidelityFlow() {
  const bodies = []
  const turns = []
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)) }
      const body = b ? JSON.parse(b) : {}
      bodies.push(`${req.method} ${req.url} ${b}`)
      const done = turns.filter((t) => t.pick).length >= 2
      const run = () => ({object: 'fidelity_run', run_id: 'r1', alias: 'ana', status: done ? 'done' : 'active', competitor: 'gpt-x', competitor_texts: 3,
        turns_total: 2, turns_done: turns.filter((t) => t.pick).length, score: done ? 1.7 : null, score_so_far: turns.reduce((a, t) => a + (t.score ?? 0), 0),
        next: done ? null : turns.length && !turns[turns.length - 1].pick ? {turn: turns.length, awaiting: 'choice'} : {turn: turns.length + 1, awaiting: 'message'},
        thread_id: null, turns: turns.map((t) => ({...t, ...(done ? {face: 'a'} : {})}))})
      if (req.url === '/v1/faces/ana/fidelity') return send(201, {...run(), estimated_usd: 0.12})
      if (req.url === '/v1/faces/bare/fidelity') return send(422, {detail: {error_code: 'fidelity_nothing_compiled', message: "'bare' has nothing compiled yet."}})
      if (req.url === '/v1/fidelity/r1/turns') {
        if (body.message === 'slow') return send(200, {detail: 'the face could not answer', error: {message: 'the face could not answer', type: 'api_error', code: '502', status: 502}})
        turns.push({n: turns.length + 1, message: body.message, answers: {a: 'A-text', b: 'B-text'}})
        return send(200, {object: 'fidelity_turn', run_id: 'r1', turn: turns.length, answers: {a: 'A-text', b: 'B-text'}})
      }
      const m = /^\/v1\/fidelity\/r1\/turns\/(\d+)\/choice$/.exec(req.url)
      if (m) {
        const t = turns[Number(m[1]) - 1]
        Object.assign(t, {pick: body.pick, correction: body.correction ?? null, score: body.correction ? 0.7 : 1})
        const fin = turns.filter((x) => x.pick).length >= 2
        return send(200, {object: 'fidelity_choice', run_id: 'r1', turn: t.n, score: t.score, score_so_far: turns.reduce((a, x) => a + (x.score ?? 0), 0), done: fin, ...(fin ? {fidelity: 1.7} : {})})
      }
      if (req.url === '/v1/fidelity/r1') return send(200, run())
      if (req.url === '/v1/fidelity/r1/save-thread') return send(200, {object: 'fidelity_thread', run_id: 'r1', thread_id: 't9', created: true})
      send(404, {detail: {error_code: 'fidelity_run_not_found', message: 'No such fidelity run.'}})
    })
  })
  await new Promise((r) => srv.listen(0, r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  const env = {...process.env, HOME: home, FACES_BASE_URL: `http://127.0.0.1:${srv.address().port}`, FACES_TOKEN: 'jwt-check'}
  const run = (args) => new Promise((r) => execFile(process.execPath, ['bin/run.js', ...args], {env}, (err, stdout, stderr) => r({code: err?.code ?? 0, out: stdout + stderr})))
  try {
    let r = await run(['fidelity:start', 'ana'])
    eq('fidelity:start names the next step', /run:\s+r1[\s\S]*fidelity:turn r1 -m/.test(r.out), true)
    r = await run(['fidelity:start', 'bare'])
    eq('fidelity:start: nothing compiled gets a hint', /Add a source with: faces compile:upload bare --file/.test(r.out), true)
    r = await run(['fidelity:turn', 'r1', '-m', 'slow'])
    eq('fidelity:turn: a held refusal is an error', [r.code, /HTTP 502: the face could not answer/.test(r.out)], [2, true])
    r = await run(['fidelity:turn', 'r1', '-m', 'hello'])
    eq('fidelity:turn prints both answers', /a:\nA-text\n\nb:\nB-text/.test(r.out), true)
    r = await run(['fidelity:pick', 'r1', 'a'])
    eq('fidelity:pick finds the open turn', bodies.some((x) => x.startsWith('POST /v1/fidelity/r1/turns/1/choice {"pick":"a"}')), true)
    r = await run(['fidelity:pick', 'r1', 'b'])
    eq('fidelity:pick before a message says so', /Turn 2 has no answers to pick from yet/.test(r.out), true)
    await run(['fidelity:turn', 'r1', '-m', 'again'])
    r = await run(['fidelity:pick', 'r1', 'b', '--correction', 'what I would say'])
    eq('fidelity:pick sends the correction', bodies.some((x) => x.includes('/turns/2/choice {"pick":"b","correction":"what I would say"}')), true)
    eq('fidelity:pick: the final score', /Finished\. Fidelity: 1\.7 out of 10/.test(r.out), true)
    r = await run(['fidelity:get', 'r1'])
    eq('fidelity:get reveals the face once done', /turn 1: picked a, the face, accepted, scored 1\n\s+turn 2: picked b, the competitor, corrected, scored 0\.7/.test(r.out), true)
    r = await run(['fidelity:save-thread', 'r1'])
    eq('fidelity:save-thread names the compile', /Saved as thread t9\nCompile it into the face: faces compile:thread:make t9/.test(r.out), true)
    r = await run(['fidelity:run', 'ana'])
    eq('fidelity:run needs a terminal', /needs a person at a terminal/.test(r.out), true)
  } finally {
    srv.close()
    fs.rmSync(home, {recursive: true, force: true})
  }
}
await fidelityFlow()

eq('fidelity score: one place', [score10(7), score10(7.25), score10(null)], ['7', '7.3', '-'])

// --- benchmark: the result, in plain lines -------------------------------------
eq(
  'benchmark result lines',
  resultLines({winner: 'face', gap: 0.12, ci95: {lo: 0.05, hi: 0.19, resolved: true}, face: 0.62, reference: 0.5, rounds_requested: 100, rounds_fought: 98,
    usage: {spend_usd: 1.234, budget_usd: 5}, seed: 42, by_length: {short: {rounds: 40, face: 0.6, reference: 0.5, gap: 0.1, ci95: null, winner: 'face'}}, by_medium: {}, warnings: ['W']}),
  [
    'winner:     the face',
    'gap:        +0.12 (95% interval +0.05 to +0.19)',
    'scores:     face 0.62, reference 0.50',
    'rounds:     98 of 100',
    'spent:      $1.23 of a $5.00 cap',
    'seed:       42  (pass --seed 42 to draw the same rounds again)',
    'by length:',
    '  short: face 0.60, reference 0.50, gap +0.10, won by face (40 rounds)',
    'warning: W',
  ],
)
eq('benchmark: too close to call', resultLines({winner: null, gap: 0.01, ci95: {lo: -0.03, hi: 0.05, resolved: false}})[0], 'winner:     neither, too close to call')
eq('benchmark: no style gets a hint', benchmarkHint(new FacesAPIError(422, 'x', {errorCode: 'benchmark_no_style'}), 'ana'), 'Build its style with: faces style:make ana --all')

// --- document vs thread: a labelled exchange is flagged, an essay is not --------
const interview = 'Interviewer: Tell me about yourself.\nAda: I am a designer in Lisbon.\n' +
  'Interviewer: What drives your work?\nAda: Making things people can repair themselves.\n'
eq('transcript: speakers found', transcriptSpeakers(interview), ['Interviewer', 'Ada'])
eq('transcript: Q and A', transcriptSpeakers('Q: Why?\nA: Because.\nQ: And then?\nA: Then we left.'), ['Q', 'A'])
eq('transcript: multi-word labels', transcriptSpeakers('Dr. Jane Smith: Hello there.\nBob Lee: Hi.\nDr. Jane Smith: How are you?\nBob Lee: Fine.'), ['Dr. Jane Smith', 'Bob Lee'])
eq('essay is not a transcript', transcriptSpeakers('I have always loved the sea.\n\nIt taught me patience.\n\nNote: this was written in 1999.'), null)
eq('one speaker is not a transcript', transcriptSpeakers('Ada: one.\nAda: two.\nAda: three.\nAda: four.'), null)
eq('a few labels in long prose are not a transcript',
  transcriptSpeakers(['Note: a.', 'Warning: b.', 'Note: c.', 'Warning: d.', ...Array(20).fill('Plain prose line.')].join('\n')), null)
eq('URLs and times are not labels', transcriptSpeakers('See https://example.com\nAt 10:30 we met.\nhttp://a.b\n12:00 lunch'), null)
eq('essay warns nothing', transcriptWarningLines('Just an essay.', 'ada', 'essay.txt'), [])
eq('transcript warning names the thread upload', transcriptWarningLines(interview, 'ada', 'interview.txt'), [
  'Warning: interview.txt reads as an exchange between speakers (Interviewer, Ada).',
  "A document is the face's own writing, so every line in it, other speakers included, is read as the face's words.",
  "Upload an interview, transcript or dialogue as a thread instead, naming the face's speaker:",
  '  faces compile:upload ada --file interview.txt --kind thread --face-speaker NAME',
])

// --- held chat: a refusal in a 200 body is an error, an answer never is ---------
const TIMEOUT = 'the face did not finish answering within 300s, so the request was stopped; retry.'
const heldChat = heldChatError({detail: TIMEOUT, error: {message: TIMEOUT, type: 'api_error', param: null, code: '504', status: 504}})
eq('held chat completions: status and message', [heldChat?.statusCode, heldChat?.message, heldChat?.errorCode], [504, TIMEOUT, 'api_error'])
const heldResp = heldChatError({detail: 'this face needs recompiling', error: {message: 'this face needs recompiling', type: 'invalid_request_error', param: null, code: '409', status: 409}})
eq('held responses: 409', [heldResp?.statusCode, heldResp?.message], [409, 'this face needs recompiling'])
const heldMsg = heldChatError({type: 'error', detail: TIMEOUT, error: {type: 'api_error', message: TIMEOUT, status: 504}})
eq('held messages (Anthropic shape): status and message', [heldMsg?.statusCode, heldMsg?.message], [504, TIMEOUT])
eq('held messages: no status is a 502', heldChatError({type: 'error', error: {type: 'api_error', message: 'boom'}})?.statusCode, 502)
eq('held: a named code is kept', heldChatError({error: {message: 'm', code: 'style_medium_unavailable', status: 400}})?.errorCode, 'style_medium_unavailable')
eq('chat completion is an answer', heldChatError({id: 'c', object: 'chat.completion', choices: [{message: {content: 'hi'}}]}), undefined)
eq('responses body is an answer, even with error: null', heldChatError({id: 'r', object: 'response', output: [], error: null}), undefined)
eq('responses body with an error object is still an answer', heldChatError({object: 'response', output: [], error: {code: 'x', message: 'y'}}), undefined)
eq('messages body is an answer', heldChatError({id: 'm', type: 'message', role: 'assistant', content: [{type: 'text', text: 'hi'}]}), undefined)
eq('no error is not a failure', [heldChatError({}), heldChatError(null), heldChatError([])], [undefined, undefined, undefined])

async function heldChatOverHttp() {
  let reply = ''
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, {'Content-Type': 'application/json', 'X-Faces-Held': '1'})
      res.write('   ')
      res.end(`  ${reply}`)
    })
  })
  await new Promise((r) => srv.listen(0, r))
  const client = new FacesClient(`http://127.0.0.1:${srv.address().port}`, undefined, 'k')
  try {
    const cases = [
      ['/v1/chat/completions', {detail: TIMEOUT, error: {message: TIMEOUT, type: 'api_error', code: '504', status: 504}}],
      ['/v1/responses', {detail: TIMEOUT, error: {message: TIMEOUT, type: 'api_error', code: '504', status: 504}}],
      ['/v1/messages', {type: 'error', detail: TIMEOUT, error: {type: 'api_error', message: TIMEOUT, status: 504}}],
    ]
    for (const [endpoint, body] of cases) {
      reply = JSON.stringify(body)
      let caught
      try { await postChat(client, endpoint, {model: 'ada@x'}) } catch (e) { caught = e }
      eq(`held ${endpoint}: thrown as a 504`, [caught instanceof FacesAPIError, caught?.statusCode, caught?.message], [true, 504, TIMEOUT])
      eq(`held ${endpoint}: hint`, faceRefusalHint(caught, 'ada@x'), 'The face did not finish within 300 seconds. Ask again.')
    }
    reply = JSON.stringify({object: 'chat.completion', choices: [{message: {content: 'hi'}}], usage: {total_tokens: 3}})
    const ok = await postChat(client, '/v1/chat/completions', {model: 'ada@x'})
    eq('held answer read through the spaces', [ok.data.choices[0].message.content, ok.headers['x-faces-held'], ok.headers['x-faces-cost-usd']], ['hi', '1', undefined])
  } finally {
    srv.close()
  }
}
await heldChatOverHttp()

// --- document warnings: the server's when it sends them, ours when it cannot ---
const SERVER_SAYS = "This looks like a conversation between several speakers. To have only Ada's turns used, upload it as a thread (with face_speaker) instead of a document."
eq('server transcript warning: its message and the thread upload, nothing else',
  documentWarningLines({document_id: 'd1', warnings: [{code: 'looks_like_transcript', message: SERVER_SAYS}]}, interview, 'ada', 'interview.txt'), [
    `Warning: ${SERVER_SAYS}`,
    '  faces compile:upload ada --file interview.txt --kind thread --face-speaker NAME',
  ])
eq('server says nothing: nothing, even for a transcript', documentWarningLines({document_id: 'd1', warnings: []}, interview, 'ada', 'interview.txt'), [])
eq('older server (no warnings field): our own check',
  documentWarningLines({document_id: 'd1'}, interview, 'ada', 'interview.txt'), transcriptWarningLines(interview, 'ada', 'interview.txt'))
eq('older server, essay: nothing', documentWarningLines({document_id: 'd1'}, 'Just an essay.', 'ada'), [])
eq('older server, no text to read: nothing', documentWarningLines({document_id: 'd1'}, undefined, 'ada', 'talk.pdf'), [])
eq('unknown warning code: its message', documentWarningLines({warnings: [{code: 'something_new', message: 'Something to know.'}]}, interview, 'ada'), ['Warning: Something to know.'])
eq('document warnings never use the thread wording',
  documentWarningLines({warnings: [{code: 'looks_like_transcript', message: SERVER_SAYS}]}, interview, 'ada').some((l) => /did not become messages/.test(l)), false)

eq('human body: warnings left out, the rest kept', withoutWarnings({document_id: 'd1', warnings: [{code: 'x'}]}), {document_id: 'd1'})

// --- llm-costs: rows carry lab, never provider -------------------------------
eq('llm-costs: lab read', llmCostLab({llm_model: 'gpt-5.4', lab: 'openai'}), 'openai')
eq('llm-costs: no lab, no provider fallback', llmCostLab({llm_model: 'x', provider: 'someone'}), '')

// --- conversations: premises as typed, items as read, turns as sent -----------
eq('premise value: JSON when it is JSON', [premiseValue('50000'), premiseValue('true'), premiseValue('null'), premiseValue('["a"]'), premiseValue('{"max":3}')], [50000, true, null, ['a'], {max: 3}])
eq('premise value: text otherwise', [premiseValue('annual'), premiseValue('Acme, Inc.'), premiseValue(''), premiseValue('  ')], ['annual', 'Acme, Inc.', '', '  '])
eq('premise value: a quoted number stays text', premiseValue('"007"'), '007')
eq('premise value: an infinite number stays text, never null', premiseValue('1e999'), '1e999')
eq('premises: value split at the first =', parsePremises(['q=a=b']), [{key: 'q', value: 'a=b'}])
eq('premises: descriptions matched by key, not position',
  parsePremises(['a=1', 'b=false'], ['b=the vendor is certified', 'a= the budget ']),
  [{key: 'a', value: 1, description: 'the budget'}, {key: 'b', value: false, description: 'the vendor is certified'}])
const premiseError = (p, d) => { try { parsePremises(p, d); return undefined } catch (e) { return e.message } }
eq('premises: no = is refused', /takes key=value \(got 'oops'\)/.test(premiseError(['oops'])), true)
eq('premises: empty key is refused', /takes key=value/.test(premiseError(['=1'])), true)
eq('premises: a bad key is refused before sending', /1 to 64 letters, digits, _ or - \(got 'has space'\)/.test(premiseError(['has space=1'])), true)
eq('premises: a 65-character key is refused', /1 to 64/.test(premiseError([`${'k'.repeat(65)}=1`])), true)
eq('premises: a 64-character key is taken', parsePremises([`${'k'.repeat(64)}=1`]).length, 1)
eq('premises: a key twice is refused', /sets 'a' twice/.test(premiseError(['a=1', 'a=2'])), true)
eq('premises: a description with no premise is refused', /names 'b', which no --premise sets/.test(premiseError(['a=1'], ['b=x'])), true)
eq('premises: an empty description is refused', /is empty/.test(premiseError(['a=1'], ['a=  '])), true)
eq('premises: two descriptions for one key are refused', /describes 'a' twice/.test(premiseError(['a=1'], ['a=x', 'a=y'])), true)
eq('premises: none is none', parsePremises(), [])

eq('turn fields: none given, nothing sent', conversationFields({}), {})
eq('turn fields: conversation, premises and causes_visible',
  conversationFields({conversation: 'fs_1', premise: ['a=1'], 'premise-description': ['a=x'], 'causes-visible': false}),
  {conversation: 'fs_1', premises: [{key: 'a', value: 1, description: 'x'}], causes_visible: false})
eq('turn fields: --session counts as the conversation', conversationFields({session: 'fs_1', premise: ['a=1']}), {premises: [{key: 'a', value: 1}]})
eq('turn fields: the same id under both names is fine', conversationFields({conversation: 'fs_1', session: 'fs_1'}), {conversation: 'fs_1'})
const turnError = (f) => { try { conversationFields(f); return undefined } catch (e) { return e.message } }
eq('turn fields: two different ids are refused', /not two different ids/.test(turnError({conversation: 'fs_1', session: 'fs_2'})), true)
eq('turn fields: premises with no conversation are refused', /belong to a conversation/.test(turnError({premise: ['a=1']})), true)
eq('turn fields: causes_visible with no conversation is refused', /belong to a conversation/.test(turnError({'causes-visible': true})), true)
eq('client items: premises first, then messages', clientItems(['hi'], [{key: 'a', value: 1}]), [{key: 'a', value: 1}, {type: 'message', role: 'user', content: 'hi'}])

eq('conversation lines: any face, causes hidden', conversationLines({object: 'conversation', id: 'fs_1', model: null, turns: 0, items: 2, causes_visible: false, status: 'open'}), [
  'conversation: fs_1', 'face:         any of your faces', 'status:       open', 'turns:        0', 'items:        2', 'causes:       each face reads its own only'])
eq('conversation lines: one face', conversationLines({object: 'conversation', id: 'fs_1', model: 'alice', causes_visible: true})[1], 'face:         alice')

const loggedItems = [
  {id: 'ci_1', type: 'function_call', name: 'premise', call_id: 'prem_1', arguments: '{"key": "budget_usd"}'},
  {id: 'ci_2', type: 'function_call_output', call_id: 'prem_1', output: '{"value": 50000, "description": "the most we can spend"}'},
  {id: 'ci_3', type: 'message', role: 'user', content: 'Worth a look?'},
  {id: 'ci_4', type: 'message', role: 'assistant', name: 'alice', model: 'gpt-x', cause: 'Money is tight.', content: [{type: 'output_text', text: 'Yes, carefully.'}]},
  {id: 'ci_5', type: 'function_call', name: 'decision', call_id: 'dec_1', face: 'alice', model: 'jev-1', arguments: '{"id": "sign", "instructions": "Sign the contract?"}'},
  {id: 'ci_6', type: 'function_call_output', call_id: 'dec_1', face: 'alice', model: 'jev-1', output: '{"answer": {"type": "choice", "choice": "no"}, "cause": "Not certified."}'},
  {id: 'ci_7', type: 'function_call_output', call_id: 'prem_2', output: '{"value": "x"}'},
  {id: 'ci_8', type: 'message', role: 'assistant', name: 'alice', cause: 'Only this.', content: ''},
]
eq('item lines: each message, decision and premise once, in order', itemLines(loggedItems), [
  'ci_2   premise  budget_usd = 50000   (the most we can spend)',
  'ci_3   you: Worth a look?',
  'ci_4   alice (gpt-x): Yes, carefully.',
  '       cause: Money is tight.',
  'ci_6   alice (jev-1) decided: Sign the contract? -> no',
  '       cause: Not certified.',
  'ci_7   output: {"value": "x"}',
  "ci_8   alice's cause: Only this.",
])
eq('item lines: a text value prints quoted, a number does not',
  itemLines([{id: 'ci_1', type: 'function_call', name: 'premise', call_id: 'p', arguments: '{"key":"k"}'}, {id: 'ci_2', type: 'function_call_output', call_id: 'p', output: '{"value":"50000"}'}]),
  ['ci_2   premise  k = "50000"'])
eq('premise lines: current values', premiseLines({budget_usd: {value: 50000, description: 'the most we can spend'}, ok: {value: false, description: null}}),
  ['premises:', '  budget_usd = 50000   (the most we can spend)', '  ok = false'])
eq('premise lines: none', premiseLines({}), ['premises: none'])
eq('conversation hint: a new premise names the flag to add',
  conversationHint(new FacesAPIError(422, "premise 'rates' is new: give its `description` (what it means, in plain words)")),
  'Say what it means: --premise-description rates="what it means, in plain words"')
eq('conversation hint: another 422 adds nothing', conversationHint(new FacesAPIError(422, '`causes_visible` is true or false')), undefined)
eq('stale decisions: none prints nothing', [staleDecisionLines([]), staleDecisionLines(undefined)], [[], []])
eq('stale decisions: what changed under each', staleDecisionLines([{call_id: 'dec_1', question: {id: 'sign', instructions: 'Sign the contract?'}, choice: 'no', face: 'alice', changed: {vendor_certified: {was: true, now: false}}}]), [
  '1 earlier decision was made under a value you just changed. Nothing was decided again:',
  '  alice: Sign the contract? -> no   [dec_1]',
  '    vendor_certified: was true, now false',
])

async function conversationsOverHttp() {
  const seen = []
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)) }
      const body = b ? JSON.parse(b) : undefined
      seen.push({method: req.method, url: req.url, body})
      const conv = {object: 'conversation', id: 'fs_1', model: body?.model ?? null, turns: 0, items: body?.items?.length ?? 0, causes_visible: body?.causes_visible ?? true, status: 'open'}
      if (req.url === '/v1/conversations' && req.method === 'POST') return send(200, conv)
      if (req.url === '/v1/conversations/gone') return send(404, {detail: 'no such conversation, or it has expired'})
      if (req.url === '/v1/conversations/any/compact') {
        if (!body?.model) return send(422, {detail: 'this conversation takes any face: name the one to compact in `model`'})
        return send(200, {object: 'cause.compaction', compaction_id: 'fcmp_1', cause: 'Position.', turns: 2})
      }
      if (req.url === '/v1/conversations/fs_1/items' && req.method === 'POST') {
        return send(200, {object: 'list', data: [], premises: {vendor_certified: {value: false, description: 'certified'}},
          decisions_made_under_old_values: [{call_id: 'dec_1', question: {instructions: 'Sign?'}, choice: 'no', face: 'alice', changed: {vendor_certified: {was: true, now: false}}}]})
      }
      if (req.url === '/v1/conversations/fs_1' && req.method === 'DELETE') return send(200, {id: 'fs_1', object: 'conversation.deleted', deleted: true})
      if (req.url === '/v1/causes') return send(200, {cause: 'Because.'})
      if (req.url.startsWith('/v1/models')) return send(200, {data: []})
      if (req.url === '/v1/chat/completions') return send(200, {object: 'chat.completion', choices: [{message: {content: 'ok'}}]})
      send(404, {detail: 'not here'})
    })
  })
  await new Promise((r) => srv.listen(0, r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-check-'))
  const env = {...process.env, HOME: home, FACES_BASE_URL: `http://127.0.0.1:${srv.address().port}`, FACES_API_KEY: 'sk-check'}
  const run = (args) => new Promise((r) => {
    const child = execFile(process.execPath, ['bin/run.js', ...args], {env}, (err, stdout, stderr) => r({code: err?.code ?? 0, out: stdout + stderr}))
    child.stdin.end()
  })
  const last = (url) => seen.filter((s) => s.url === url).at(-1)?.body
  try {
    let r = await run(['conversation:create'])
    eq('conversation:create: no face, causes visible, no items', last('/v1/conversations'), {causes_visible: true})
    eq('conversation:create: any face reads as such', /face:\s+any of your faces/.test(r.out), true)
    await run(['conversation:create', 'alice', '--no-causes-visible', '-m', 'hi', '--premise', 'a=1', '--premise-description', 'a=the budget'])
    eq('conversation:create: face, causes hidden, premises then messages', last('/v1/conversations'),
      {causes_visible: false, model: 'alice', items: [{key: 'a', value: 1, description: 'the budget'}, {type: 'message', role: 'user', content: 'hi'}]})
    seen.length = 0
    r = await run(['conversation:create', 'alice@gpt-x'])
    eq('conversation:create: a model is refused before sending', [r.code, /face alone: alice/.test(r.out), seen.length], [2, true, 0])
    r = await run(['conversation:add', 'fs_1', '--premise', 'vendor_certified=false'])
    eq('conversation:add: sent as items', last('/v1/conversations/fs_1/items'), {items: [{key: 'vendor_certified', value: false}]})
    eq('conversation:add: decisions under old values, readably',
      [/1 earlier decision was made under a value you just changed/.test(r.out), /alice: Sign\? -> no/.test(r.out), /vendor_certified: was true, now false/.test(r.out)], [true, true, true])
    seen.length = 0
    r = await run(['conversation:add', 'fs_1'])
    eq('conversation:add: nothing to add is refused before sending', [r.code, seen.length], [2, 0])
    r = await run(['conversation:add', 'fs_1', ...Array.from({length: 21}, (_, i) => ['-m', `m${i}`]).flat()])
    eq('conversation:add: more than 20 is refused before sending', [r.code, /At most 20/.test(r.out), seen.length], [2, true, 0])
    r = await run(['conversation:get', 'gone'])
    eq('conversation:get: 404 says how to start another', /faces conversation:create/.test(r.out), true)
    r = await run(['conversation:compact', 'any'])
    eq('conversation:compact: any-face 422 says to name the face', /faces conversation:compact any <face>/.test(r.out), true)
    await run(['conversation:compact', 'any', 'alice'])
    eq('conversation:compact: the face is sent', last('/v1/conversations/any/compact'), {model: 'alice'})
    r = await run(['conversation:close', 'fs_1', '--yes', '--json'])
    eq('conversation:close: the server\'s answer', JSON.parse(r.out).deleted, true)

    await run(['causes', 'alice', '-m', 'Now?', '--conversation', 'fs_1', '--premise', 'a=1', '--premise-description', 'a=x'])
    eq('causes: conversation and premises sent, causes_visible left out', last('/v1/causes'),
      {model: 'alice', messages: [{role: 'user', content: 'Now?'}], conversation: 'fs_1', premises: [{key: 'a', value: 1, description: 'x'}]})
    await run(['causes', 'alice', '-m', 'Now?', '--session', 'fs_1', '--no-causes-visible'])
    eq('causes: --session still sent as session', last('/v1/causes'), {model: 'alice', messages: [{role: 'user', content: 'Now?'}], session: 'fs_1', causes_visible: false})
    seen.length = 0
    r = await run(['causes', 'alice', '-m', 'Now?', '--premise', 'a=1'])
    eq('causes: premises without a conversation are refused before sending', [r.code, /belong to a conversation/.test(r.out), seen.length], [2, true, 0])

    await run(['chat:chat', 'alice@gpt-x', '-m', 'one', '--json'])
    let t = await run(['chat:thread', 'alice@gpt-x', '-m', 'first', '--json'])
    const tid = JSON.parse(t.out).thread_id
    await run(['chat:thread', '--id', tid, '-m', 'second', '--json'])
    eq('thread: without a conversation, the whole thread is sent', last('/v1/chat/completions').messages.map((m) => m.content), ['first', 'ok', 'second'])
    await run(['chat:thread', '--id', tid, '-m', 'third', '--conversation', 'fs_1', '--premise', 'a=2', '--json'])
    const sent = last('/v1/chat/completions')
    eq('thread: in a conversation, only the new message', [sent.messages.map((m) => m.content), sent.conversation, sent.premises], [['third'], 'fs_1', [{key: 'a', value: 2}]])
    await run(['chat:chat', 'alice@gpt-x', '-m', 'one', '--conversation', 'fs_1', '--no-causes-visible', '--json'])
    eq('chat:chat: conversation and causes_visible sent', [last('/v1/chat/completions').conversation, last('/v1/chat/completions').causes_visible], ['fs_1', false])
  } finally {
    srv.close()
    fs.rmSync(home, {recursive: true, force: true})
  }
}
await conversationsOverHttp()

console.log(`${ran - failed}/${ran} checks passed`)
if (failed > 0) process.exit(1)
