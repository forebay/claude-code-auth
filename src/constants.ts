/** The public installed-app client every Claude Code user authenticates against; it has no secret. */
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** The environment variable that replaces {@link CLAUDE_CLIENT_ID}. */
export const CLIENT_ID_VARIABLE = "CLAUDE_CODE_CLIENT_ID";

/** Where the authorize flow lands, showing the `code#state` the user pastes back. */
export const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";

/** The scopes a subscription token is requested with. */
export const CLAUDE_SCOPES = ["org:create_api_key", "user:profile", "user:inference"];

/** The API version every upstream request declares. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** The beta flag an OAuth-token request needs rather than an API key. */
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

/** The first system block Anthropic requires on an OAuth-token request. */
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Why an account is disabled when the upstream rejects its token for lacking the inference scope. */
export const INFERENCE_SCOPE_REASON = "re-login required (token lacks inference scope)";

/** Claude subscription limits are account-wide, so every request shares one lane. */
export const MESSAGES_LANE = "messages";
