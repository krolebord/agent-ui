# Available Agent Tools

Snapshot for debugging. Lists tools exposed to the agent in this Cursor session.

## Core file & workspace tools

### Read
Read files from the filesystem. Supports images (jpeg/jpg, png, gif, webp). Optional `offset` and `limit` for partial reads.

### Write
Create or overwrite a file with the given contents.

### StrReplace
Perform exact string replacements in a file. Supports `replace_all`.

### Delete
Delete a file at the given path.

### Glob
Find files matching a glob pattern (recursive by default with `**/` prefix).

### Grep
Search file contents with ripgrep. Modes: `content`, `files_with_matches`, `count`. Supports context lines, case-insensitive search, glob filters, multiline, etc.

### ReadLints
Read linter/diagnostic errors from the workspace for given paths or the whole workspace.

### EditNotebook
Edit Jupyter notebook cells (create or edit). Cell indices are 0-based.

## Shell & execution

### Shell
Execute commands in a shell session. Supports background execution, `block_until_ms`, working directory, and optional output monitoring via `notify_on_output`.

### Await
Poll a background shell by `shell_id`. Can block until output matches a regex pattern or until timeout.

## Planning & orchestration

### TodoWrite
Create and manage a structured task list (`pending`, `in_progress`, `completed`, `cancelled`). Supports merge or replace.

### Task
Launch specialized subagents:
- `generalPurpose` — research, search, multi-step tasks
- `cursor-guide` — Cursor product documentation
- `best-of-n-runner` — isolated git worktree experiments

Supports `resume`, optional `model` (`composer-2.5-fast`), `readonly`, and file attachments.

### SwitchMode
Switch interaction mode:
- `agent` — full implementation access
- `plan` — read-only collaborative planning

## Web & media

### WebSearch
Search the web for real-time information.

### WebFetch
Fetch URL content and return readable markdown.

### GenerateImage
Generate an image from a text description. Only when the user explicitly requests an image.

## MCP — Context7

### mcp_context7_resolve-library-id
Resolve a package/product name to a Context7-compatible library ID (e.g. `/org/project`). Call before `query-docs` unless the user provides an ID.

### mcp_context7_query-docs
Retrieve up-to-date documentation and code examples from Context7 for a library ID. Max 3 calls per question.

## MCP — generic resources

### ListMcpResources
List available resources from configured MCP servers.

### FetchMcpResource
Read a specific resource from an MCP server by server name and URI. Optional download to workspace path.

## MCP servers configured in this session

| Server     | Purpose                                      |
| ---------- | -------------------------------------------- |
| `context7` | Library documentation lookup                 |

---

*Generated for debugging. Tool set may differ by Cursor version, mode (Agent vs Ask), and MCP configuration.*
