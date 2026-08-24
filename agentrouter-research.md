# AgentRouter verification

Source: https://co.agentrouter.org/portal/guide (official AgentRouter documentation, accessed 2026-08-24).

The official guide states that OpenAI-compatible requests use `https://co.agentrouter.org/v1`, while Anthropic-compatible requests use `https://co.agentrouter.org` without `/v1`. The API key is the AgentRouter platform key and the Model ID must be the model identifier supported by the receiving agent; organization-specific suffixes take priority when applicable.

For Kilo Code, the guide specifies a custom provider with Provider ID `agentrouter`, Display Name `AgentRouter`, Base URL `https://co.agentrouter.org/v1`, OpenAI Compatible protocol, and model IDs such as `claude-opus-4-8`, `gpt-5.5`, `glm-5.1`, and `kimi-k2.6`.

For Claude Code and other Anthropic-compatible agents, the guide specifies Anthropic protocol, base URL without `/v1`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL=https://co.agentrouter.org`, and model selection through `ANTHROPIC_MODEL`.

Implementation implication: AgentRouter cannot be treated as one universal OpenAI Chat preset. The provider needs explicit route/protocol selection based on model family or an explicit user-selected AgentRouter mode. OpenAI-family models should use the `/v1` Chat Completions route; Claude-family models should use the Anthropic Messages route without `/v1`. A custom provider implementation must preserve the user-entered base URL when an explicit route is selected and must not silently rewrite an Anthropic endpoint to OpenAI Chat.
