# Connect and administer GBrain MCP

Choose the task first. Connecting a harness and administering the server use
different credentials.

| Task | Start here | Required access |
| --- | --- | --- |
| Run an HTTP MCP server | [Deployment](DEPLOY.md) | Access to the brain host and its service configuration |
| Open the admin panel or manage clients | [MCP administration](ADMIN.md) | The running server's separate owner bootstrap credential |
| Connect an existing agent | [Hosted harness setup](../guides/hosted-harness-access.md) | Native OAuth/PKCE, or a private machine-client handoff |
| Run a local MCP pipe | [Local stdio](DEPLOY.md#local-stdio-zero-setup) | A local GBrain installation; no HTTP admin panel is created |
| Diagnose a failed connection | [Recovery table](ADMIN.md#recover-a-failed-step) | Start with the failed stage and the authority you actually hold |

**For agents:** read [the MCP access skill](../../skills/mcp-access/SKILL.md).
If skill tools are unavailable, the instructions here and in
[ADMIN.md](ADMIN.md) work directly. A connected harness can also read
`gbrain://capabilities` for its effective permissions and administration guidance.

**Owner administration is separate from MCP `admin` scope.** An OAuth access
token, client secret, or ordinary MCP connection does not authorize dashboard
login, client creation, or client revocation. A public PKCE client has no client
secret. Ask the server-hosting harness or a separately authorized administrator
to perform owner actions.

Say to that administrator: “Open the admin panel for my running GBrain server.
Use its configured endpoint and protected owner credential. Give me a fresh
single-use login link without opening it yourself.”

Say to the connecting agent: “Connect this harness to my hosted GBrain. Use its
native OAuth flow if available; otherwise use a private machine handoff. Follow
the hosted setup guide and report configuration separately from an observed
connection in this harness.”

Tool descriptions are deliberately short (the starter list is pinned at 25,000
characters by `test/mcp-schema-budget.test.ts`); the longer guidance for each
starter tool is in the [MCP tool reference](TOOL_REFERENCE.md).

Client-specific details: [ChatGPT](CHATGPT.md), [Claude Code](CLAUDE_CODE.md),
[Claude Desktop](CLAUDE_DESKTOP.md), [Codex](CODEX.md),
[opencode](OPENCODE.md), [Perplexity](PERPLEXITY.md),
[OpenClaw](OPENCLAW.md), and the [adapter reference](../guides/harness-adapters.md).

## Search and query result rows

`search` and `query` return their rows as compact JSON in the first content
block. Remote callers get **lean rows** by default: the fields an agent acts
on, without the ranking diagnostics that made each row several times longer
than its evidence text.

A lean row keeps `id` (the `fetch` key), `slug`, `title`, `type`,
`chunk_text`, `score`, `effective_date`, `source_id`, `chunk_id` (with
`slug` and `source_id`, the `assemble_evidence` hit), `evidence` and
`create_safety` (the duplicate-page guard). It also keeps every safety or
provenance marker that is present: `injection_suspected`, `injection_p`,
`unverified`, `content_flag`, `status`, `superseded`, `superseded_by`,
`message_id`, `thread_id`, `source_subject`, `modality` when not `text`,
`stale` when true, and `delivered: {"truncated": true}` when evidence
delivery cut the text.

```json
{"query": "acme-example renewal terms"}
```

```json
[{"slug":"contracts/acme-example-msa","title":"MSA: Acme Example","type":"contract","chunk_text":"Payment terms: Net 45. Renewal is annual.","chunk_id":812,"score":0.91,"source_id":"default","effective_date":"2026-04-02","id":"gbrain-page:v1:WyJkZWZhdWx0IiwiY29udHJhY3RzL2FjbWUtZXhhbXBsZS1tc2EiXQ","evidence":"keyword_exact","create_safety":"probable"}]
```

Pass `fields: "full"` to get every field (`page_id`, `chunk_index`,
`chunk_source`, `keyword_hit`, `cosine`, `base_score`, boosts, rerank and
graph signals, the full `delivered` object):

```json
{"query": "acme-example renewal terms", "fields": "full"}
```

`_meta.retrieval.rows` reports `"lean"` or `"full"` for every remote call.

| Client | Rows by default | How to get full rows |
| --- | --- | --- |
| Any MCP client (stdio or HTTP) | lean | `fields: "full"` per call, or the host sets `gbrain config set mcp.result_rows full` |
| gbrain thin CLI, this release or later | full (it sends `X-Gbrain-Client`) | nothing to do |
| gbrain thin CLI, older release | lean | upgrade the CLI, or the host sets `mcp.result_rows full` |
| Trusted local CLI (`gbrain search`, `gbrain call`) | full | nothing to do |

The host setting is read per request over OAuth HTTP and at start-up for
`gbrain serve` (stdio), so restart a stdio server after changing it. The
`X-Gbrain-Client` header selects a row shape only; it is not an identity
claim and never grants access.

Say to your agent: *"Search my brain for the acme-example renewal terms and
show me every ranking field for the top result."*
