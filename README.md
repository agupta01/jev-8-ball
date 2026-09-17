# jev-8-ball

A single-screen, pixel-art magic 8 ball. Static HTML/CSS/JavaScript on GitHub
Pages; a Turnstile-protected FastAPI service on Modal; eight independent Noul
judgments in one request to TypeSafe's `jev-latest`.

## Run and deploy

```sh
uv sync
MODAL_PROFILE=agupta01 uv run python dev.py
```

Open `http://localhost:4173` (or `http://127.0.0.1:4173`) to play locally with real
Jev answers. The local server requires your authenticated `agupta01` Modal profile
and the deployed `development_question` function; run the deployment command below
once after setting up a new environment.

`dev.py` binds only to loopback and serves a development-only `/config.js` using
[Cloudflare's official test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
No Cloudflare hostname changes are needed. Its `/api/ask` validates the test
challenge and invokes a **private, authenticated Modal RPC** using your local
Modal credentials. The TypeSafe key stays inside Modal; real inference is billed
to your TypeSafe account. Host and Origin checks prevent foreign web pages from
using this local endpoint.

Do not expose this development server publicly. The production `site/config.js`
is unchanged, and GitHub Pages uploads only `site/`, never `dev.py`. The public
production API rejects localhost origins and Cloudflare test tokens. A plain
`python -m http.server` is only a static preview, not the development server.

Deploy the backend:

```sh
uv run modal deploy main.py --profile agupta01 --env jev-8-ball-prod
```

The Modal environment needs:

- `typesafe`: `TYPESAFE_API_KEY`
- `cloudflare-turnstile`: `SECRET_KEY` and public `SITE_KEY`

`site/config.js` contains only the public widget key and deployed API URL.
The API uses Python 3.12 because this Modal workspace uses the legacy image
builder. Local development uses Python 3.13.

Push the project to `main` to publish `site/` through
`.github/workflows/pages.yml`. GitHub Pages is configured to use Actions.
This account's Pages custom domain is inherited by the project:
**https://www.arunavgupta.com/jev-8-ball/**.
The Turnstile widget must allow `www.arunavgupta.com`.

GitHub's project-level HTTPS enforcement API currently reports that its
certificate does not exist, although the inherited domain serves HTTPS.
The page redirects HTTP visits on that domain to HTTPS before loading the app.
When GitHub makes the project certificate available, enable “Enforce HTTPS”
in Pages settings as well.

## Request and protection

`POST /ask` accepts:

```json
{"question": "Is the sun a star?", "turnstile_token": "<fresh widget token>"}
```

The API requires the exact production Origin, then verifies the token with
Cloudflare and checks `success`, `hostname`, and action `ask`. Turnstile tokens
are short-lived and single-use. CORS alone is not authentication, and this
anonymous protection is not a guarantee against determined automated abuse.
There is no public verification bypass.

A successful request returns eight `{id, text, probability}` answers, the model
identifier, and `elapsed_ms` measured around the Jev HTTP call. Each probability
measures whether that fixed answer fits the question; they are independent,
do not sum to 100%, and are not predictions of real-world events. The frontend
chooses the highest score, keeping the first answer on ties.

Each answer has its own Noul `true`/`false` criteria in `main.py`.
Ordinary low-stakes uncertainty permits a playful directional answer rather
than automatically forcing abstention. “Signs point to yes” is tentative
encouragement; “Most likely” needs a favorable common-sense expectation;
“It is certain” needs decisive facts. The negative answers distinguish firm
contradiction, implausibility, and concrete adverse circumstances.
“Reply hazy” covers unclear wording or genuinely conflicting clues.
“Cannot predict now” is reserved for random outcomes, unavailable external
information, or individualized expert determinations. Probabilities are not
rescaled or overridden to force variety.

The game logs the response immediately but waits at least 2.4 seconds before
revealing its downward-pointing triangle. The die and liquid share the same pixel
renderer, with beveled edges, a submerged shadow, and a shared glass reflection.
The answer label stays sans-serif and scales with the ball. The question remains editable, and overlapping button,
keyboard, or motion submissions cannot send concurrent requests. Phone shake
requires a secure context, sensor support, and permission on devices that
request it. The button remains available. Reduced-motion preferences disable
the movement effects.

## Modal request logs

```sh
uv run modal app logs jev-8-ball --profile agupta01 --env jev-8-ball-prod --tail 100 --timestamps
```

Add `--follow` instead of `--tail 100` to stream. Structured JSON events cover
HTTP start/completion, Turnstile success/failure, Jev start/completion/failure,
and authenticated development RPCs. They include a request ID, status, stage
timings, model, winner, and all eight probabilities. Public HTTP responses
include `X-Request-ID` for correlation. API keys, verification tokens, request
bodies, and raw question text are not logged.

The on-screen timing and eight scores are appended together immediately after
the response JSON is parsed and validated, before the remaining 2.4-second hold
and triangle reveal. These are not streamed individual model results. The
displayed Jev duration measures the backend's TypeSafe HTTP call, not Turnstile,
browser round-trip time, or animation time.

## Replay in the Jev playground

Select `jev-latest` at https://console.typesafe.ai/decode and paste:

- **State:** [`examples/jev-playground-state.json`](examples/jev-playground-state.json)
- **Schema / Questions:** [`examples/jev-playground-schema.json`](examples/jev-playground-schema.json)

These files were captured from the outgoing JSON of a real TypeSafe request,
not reconstructed from a shortened example. The schema file is the eight-question
map, without an outer `questions` wrapper. The capture used “Will my date go well?”
and resolved to `jev-1.13.0`; its winner was “Signs point to yes” at 0.80.
Results may vary between calls or model versions.

## Verification

```sh
uv run python -m unittest discover -s tests -v
```

The tests protect origin and Turnstile hostname/action boundaries, input limits,
single-batch behavior, rejection of incomplete or invalid probabilities, and the
development server's cross-origin and DNS-rebinding boundaries.
They mock external services; they do not spend production inference tokens.

Live verification exercised the deployed denial paths and three real Jev batches
using a private authenticated Modal job. Browser checks exercised the game with
isolated network fixtures: immediate responses, delayed reveal, repeat questions,
failure recovery, simulated motion, reduced motion, and portrait/landscape layouts
from 320×568 to 1440×900. No test tokens or fixtures are shipped in `site/`.

The complete local browser flow was also exercised without request interception:
the real Cloudflare test widget, its verification service, authenticated Modal RPC,
and real Jev inference. “Is the sun a star?” selected “It is certain.” and a repeat
question “Is the Earth flat?” selected “Absolutely not.” Production rejection of
the dummy token was separately verified.

A live 14-question spot-check of these criteria on `jev-1.13.0` gave directional
answers to all six ordinary choices/forecasts, preserved correct factual yes/no
answers, and kept “Cannot predict now” for a coin flip, live package status, and
a personal medical outcome. “Should I do it?” selected “Reply hazy”; poor exam
preparation selected “Outlook not so good.” This is a representative spot-check,
not a measured accuracy guarantee or a deterministic model regression test.

The real Turnstile widget loaded in an automated browser with local assets served
under the production origin through request interception, but its human challenge
did not complete. A human browser check on the published site is still required
for the complete Turnstile-to-Jev path.