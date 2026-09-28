# Background context reports

The SDK `get_context_usage` control request now collects category estimates
locally. Its total still uses the latest actual provider input/cache usage,
when present, exactly as before. Without actual usage the total remains an
estimate. Explicit `/context` and inference token-count callers retain their
existing API path.

Previously each report ran parallel count requests for system sections, tools,
memory, agents and messages. The count client had a 600-second default timeout
and one retry. A failed count then invoked a model to obtain input usage.
Consequently a background display generated substantial provider/auth traffic,
and one slow request kept the entire report pending. Production observations
included background reports lasting 150.036 and 112.657 seconds, and provider
response-header resets after 147.979 and 110.410 seconds. Those reports did not
block stdin ingestion, but remained unnecessary network work.

The local policy uses AsyncLocalStorage so concurrent conversation requests
keep their normal behavior. Deferred-tool count memoization separates local
estimates from API counts, avoiding shared cache contamination or waiting for
an in-flight API count. Existing category estimation and tool overhead handling
are retained; this change neither changes model selection nor tool permissions.

Validation on 2026-09-28:

- Four focused scope/control-protocol tests passed, including host-token reply,
  second-message and interrupt processing.
- `node scripts/test-background-context.mjs --baseline` on the previous bundle:
  two reports caused 60 count HTTP requests and 30 fallback inference requests
  in addition to the two intended conversation turns; 2157 ms with an 800-ms
  failing count fixture.
- The rebuilt CLI passed the same fixture: two reports in 9 ms, no count HTTP
  requests, only the two intended inference calls. Both reports retained the
  exact fixture usage total of 1384 input/cache tokens and nonempty categories.

The local fixture is not live-provider or deployed-product acceptance.
