# Cloudflare AI Application Assignment

This repository is for the optional Cloudflare Software Engineer — Platforms & Productivity application assignment. Completing it may fast-track the candidate.

## Submission

- Submit the public GitHub repository URL with the job application.
- Include a clear `README.md` covering the problem, architecture, local development, deployment, trade-offs, and how to use the application.
- Include the complete AI-coding prompt history in `PROMPT_HISTORY.md`.

## Required application components

Build an AI-powered application on Cloudflare with all of the following:

1. **LLM** — Prefer Llama 3.3 through Workers AI, or use an external LLM provider.
2. **Workflow / coordination** — Prefer Cloudflare Workers, Workflows, or Durable Objects to coordinate multi-step work, agent/tool calls, or asynchronous tasks.
3. **User input via chat or voice** — Prefer a Pages chat UI or Cloudflare Realtime for voice / real-time interaction.
4. **Memory or state** — Persist information beyond one request, such as conversation history, user preferences, job status, or stored knowledge. Durable Objects, D1, KV, R2, and Vectorize are possible options.
5. **Prompt history** — AI-assisted coding is encouraged, but the prompt history must be submitted with the project.

## Project direction

Favor a practical developer-productivity, CI/CD, GitOps, platform-engineering, or engineering-guardrails use case. A strong option is a Developer Productivity AI Assistant that accepts CI logs or a pull-request description, identifies likely failures, recommends remediation steps, and retains relevant project/session context.

Prioritize a usable interface, secure and reliable behavior, clear TypeScript/Go/Bash code, meaningful Cloudflare service integration, and thoughtful handling of errors and state.

## Prompt-history requirement

**Every substantive user prompt made while planning, designing, or coding this project must be appended verbatim to `PROMPT_HISTORY.md`.** Add the prompt as part of completing the corresponding request, preserving chronological order. Include enough context to distinguish prompts, such as a timestamp or sequential entry number. Early unrelated brainstorming before a project was selected is excluded.
