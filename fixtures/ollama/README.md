These are hand-authored **synthetic Ollama-shaped** protocol fixtures, not captures from a server.
They contain no endpoint, account or hardware evidence. `chat-cases.json` stores exact NDJSON lines
as strings so errors, omitted fields, partial lines and parser expectations remain reviewable.
Byte split, malformed UTF-8, negative/nonfinite metrics, caps and timeout cases are authored in the
contract/CLI test sources. All runtime checks remain deferred during Dirty Mode.
