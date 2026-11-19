# Targeting benchmark

`bun run bench:targeting` measures "find controls by description": how often each
model picks the element a person meant, how fast, at what cost, and how honest
its percentages are. It also measures what Claude does when no model is set up.

It runs with no keys at all (only the baseline), and adds every provider that has
a key. It never touches a browser: the pages are outlines written for the test
(`bridge/targeting-tasks.ts`), a saved playlist page outline
(`test/fixture-tree.txt`), and car pages built from `test/fixtures.ts`.

## How to run

```sh
bun run bench:targeting                    # baseline + every provider with a key
bun run bench:targeting --only baseline    # no model calls
bun run bench:targeting --models nexos=gpt-4.1-mini,ollama=llama3.1:8b
bun run bench:targeting --providers nexos --no-write
```

Keys are read where the bridge reads them (`~/.config/typesafe/env` for TypeSafe,
`~/.browsteer/keys.env` for the others). An OpenAI-compatible provider also needs a
model: the one chosen in Settings, or `--models`. A local Ollama is used when it
answers on 127.0.0.1:11434. Paid providers get one small request per task, plus one uncounted warm-up (26 per run).

## What the columns mean

**Providers table**

- **right**: tasks where the provider's first pick is the element meant. For a
  target that is not on the page, right means it said "nothing matches".
- **mean / p95 latency**: time for one find, from asking to answer. p95: 95 of
  100 finds are at least this fast.
- **tokens per task**: tokens the provider was billed for one find (page outline in,
  answer out). These are the provider's tokens, not Claude's.
- **Brier score**: how well the provider's percentages match reality, from 0
  (always sure and right) to 1 (always sure and wrong). For each task: take the
  percentage it gave its answer, subtract 1 if the answer was right or 0 if it was
  wrong, square it; then average. A model that says 90% and is right 9 times in 10
  scores about 0.09. Lower is better.
- **probabilities**: *calibrated* when the percentages come from the model's own
  token probabilities (TypeSafe Jev, or an endpoint that returns logprobs);
  *uncalibrated* when the model wrote its own estimate as text. Browsteer is more
  careful with uncalibrated answers: it returns a shortlist instead of clicking
  unless the model is at least 95% sure.
- **errors**: requests that failed (network, refused key, unreadable reply).

**Without a provider table**

- **snapshot reply**: how much Claude reads when it has no provider: the whole
  `browser_snapshot` reply for that page, in tokens (characters ÷ 4).
- **round trips**: tool calls Claude makes. Without a provider it is 2
  (`browser_snapshot`, then `browser_click` on a ref); with one it is 1
  (`browser_find` with `act: "click"`).
- **find reply**: the size of a typical `browser_find` reply for that task.
- **find, no provider**: `browser_find` with no model still answers when the
  description contains the control's exact name ("lexical"). *needs a model* means
  Claude has to take a snapshot instead.
- Provider columns: right or wrong, and the percentage the provider gave its pick
  (for a target that is not on the page: the percentage it gave "it is on the page").

## Latest results

From the last run on a development machine: only the providers that machine had
set up appear, so run it yourself to compare the ones you use.

### Providers (25 tasks, 2026-11-19)

| provider | model | right | mean latency | p95 latency | tokens per task | Brier score | probabilities | errors |
|---|---|---|---|---|---|---|---|---|
| Local (Ollama) | gemma3:12b | 21/25 | 1596 ms | 1854 ms | 1397 | 0.096 | calibrated | 0 |

Skipped: typesafe (no TypeSafe key), nexos (no key), openrouter (no key), custom (no address set).

### Without a provider: what Claude does instead

| task | page | snapshot reply | round trips | find reply | round trips | find, no provider | Local (Ollama) |
|---|---|---|---|---|---|---|---|
| "the button that takes me to payment" | cart | 113 tok | 2 | 72 tok | 1 | needs a model | right, 100% |
| "where I type my password" | login | 83 tok | 2 | 73 tok | 1 | lexical, right | right, 100% |
| "the field for a discount code" | cart | 113 tok | 2 | 70 tok | 1 | needs a model | right, 100% |
| "take the mouse out of my cart" | cart | 113 tok | 2 | 73 tok | 1 | needs a model | right, 100% |
| "change how many I'm buying" | cart | 113 tok | 2 | 70 tok | 1 | needs a model | right, 100% |
| "track my order" (not on page) | cart | 113 tok | 2 | 83 tok | 1 | needs a model | right, present 0% |
| "stay logged in on this device" | login | 83 tok | 2 | 76 tok | 1 | needs a model | right, 100% |
| "I forgot my login details" | login | 83 tok | 2 | 74 tok | 1 | needs a model | right, 100% |
| "sign up for a new account" | login | 83 tok | 2 | 75 tok | 1 | needs a model | right, 100% |
| "skip to the next song" | music | 927 tok | 2 | 74 tok | 1 | needs a model | right, 100% |
| "make a new playlist" | music | 927 tok | 2 | 75 tok | 1 | lexical, right | right, 100% |
| "the volume control" | music | 927 tok | 2 | 73 tok | 1 | needs a model | wrong, 100% |
| "show the song lyrics" | music | 927 tok | 2 | 76 tok | 1 | needs a model | wrong, 66% |
| "go to my libraries" | music | 927 tok | 2 | 74 tok | 1 | lexical, right | wrong, 99% |
| "the playlist of Lithuanian road trip songs" | music | 927 tok | 2 | 82 tok | 1 | needs a model | right, 100% |
| "search the music collection" | music | 927 tok | 2 | 77 tok | 1 | needs a model | right, 100% |
| "log out of my account" (not on page) | music | 927 tok | 2 | 90 tok | 1 | needs a model | right, present 0% |
| "show all photos of the car" | listing | 1198 tok | 2 | 84 tok | 1 | needs a model | wrong, 100% |
| "the battery certificate" | listing | 1198 tok | 2 | 88 tok | 1 | needs a model | right, 100% |
| "apply for a loan offer" | listing | 1198 tok | 2 | 88 tok | 1 | needs a model | right, 100% |
| "the dealer's website" | listing | 1198 tok | 2 | 87 tok | 1 | needs a model | right, 100% |
| "choose the loan term in months" | listing | 1198 tok | 2 | 83 tok | 1 | lexical, right | right, 100% |
| "save this car to my favourites" (not on page) | listing | 1198 tok | 2 | 100 tok | 1 | needs a model | right, present 0% |
| "the cheapest car" | results | 287 tok | 2 | 132 tok | 1 | needs a model | right, 100% |
| "the one with 54.675 km" | results | 287 tok | 2 | 132 tok | 1 | needs a model | right, 100% |

Totals over 25 tasks: Claude reads 16075 tokens of snapshots and makes 50 tool calls without a provider; with one it reads 2081 tokens of find replies in 25 calls (87% fewer tokens). With no provider at all, find still answers 4 of 25 tasks by exact name (lexical match); the rest need a model or a snapshot.
