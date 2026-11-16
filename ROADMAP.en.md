# Piko roadmap

English | [中文](ROADMAP.md)

Piko is under active development. This document summarizes implemented capabilities, current limitations and possible directions; it is not a stable-release promise or a dated delivery plan. The detailed [product](docs/design/PRODUCT.md) and [architecture](docs/design/ARCHITECTURE.md) documents are in Chinese.

## Current implementation

| Area | Status |
| --- | --- |
| Chat | Persistent main conversation, streaming responses, stop, additional input while running and recovery after disconnection; Durable's SQLite stores the complete original history. |
| Side chats | Separate history and context; create, generate or refresh titles asynchronously, stop and permanently delete after confirmation. They do not inherit main-chat history. |
| Tasks | Run manually, once, or on a Cron schedule; request tasks in Chat, inspect execution records and archive or restore them in Tasks. |
| Background work | The assistant can delegate to independent sub-sessions; it handles results without displaying the sub-session transcript. Temporary work without a long-term owner is checked every 24 hours and reclaimed after seven days of inactivity. |
| Workspace | File and shell tools, skills, and daily and long-term memory maintenance; the workspace is on the backend machine. |
| Web tools | Built-in web search and extraction; the deployer configures provider credentials on the backend. |
| Telegram | Optional single-user private chat sharing the main conversation with the app; not a multi-user bot. |
| Posts | Automatic daily generation attempt at 07:00 server-local time or manual generation, title/body/reason, native storage and history search, card list, shared reader and confirmed deletion; no notifications. |
| Artifacts | Browse `workspace/artifacts/`, preview Markdown and common text, download from the list menu and delete after confirmation. Task execution files and binary previews are not integrated. |
| Settings | Device-local language (follow device, Chinese or English) and appearance; main/background model and thinking-level selection. Providers, model catalog, credentials, tools, channels and environment variables are deployment-managed. The model-selection API is not authenticated. |
| Client and server | Expo Web/iOS/Android client; a single Bun process serves Web, API/SSE and optional Telegram. A general deployment solution has not been established. |

The [feature documentation](docs/README.en.md#design-and-implementation-references) contains implementation details and validation boundaries in Chinese. Exports and simulated checks are not equivalent to acceptance with real models, Telegram networks or native devices.

## Current limitations

- The daily Posts schedule is not configurable and there are no notifications or editing. Artifacts only browses global `workspace/artifacts/`; it does not aggregate `workspace/tasks/<id>/` results or support creating, renaming, moving, or built-in PDF/Office previews.
- Web chat supports selecting and uploading attachments. Native iOS/Android file selection and in-chat image thumbnails are not implemented.
- There is no built-in login, multi-user isolation, fine-grained permissions, operation approval or file sandbox. Settings writes are unauthenticated too; do not expose the API to untrusted networks.
- Telegram delivery has no reliable outbox. A saved assistant reply may not be redelivered after a restart or network failure.
- Push notifications, browser automation, calendar/email connectors, memory browsing and skill management UI are not implemented.
- Native keyboard, background recovery and accessibility, as well as real model and Telegram Bot behavior, still need validation in target environments.

## Possible directions

Priorities depend on real-world use; these are directions, not commitments:

1. Clarify security boundaries: authentication, tool permissions, workspace access and confirmation for high-risk actions.
2. Improve existing capabilities: mobile attachments, memory/skill management, and task-result and artifact aggregation.
3. Evaluate topic selection, context and reading value using daily posts before deciding whether to adjust generation.
4. Evaluate browser automation, external service connectors and multi-user deployment; do not automate external operations before permissions and revocation are defined.

The top-level navigation remains Chat, Tasks, Posts and Artifacts. New pages should reflect implemented data and behavior rather than mock content.

## Release and validation principles

- Distinguish implemented, partially implemented and unimplemented behavior; do not describe plans as existing capabilities.
- Validate critical persistence, stop, deduplication, deletion and recovery using isolated data, never a real workspace.
- State when native devices, external networks or real models are required for verification.
- Resolve authentication and permission boundaries before public deployment. The current version is intended only for local or trusted environments.
