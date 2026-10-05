/** Programmatic entry point, so the server can be embedded or tested without spawning. */
export { createServer } from './server.ts';
export { boundaryFrom, projectDir, insideProject, isSecretish, PathRefused } from './paths.ts';
export type { Boundary } from './paths.ts';
export { handoffPrompt, receivePrompt, skillFiles } from './prompts.ts';
export type { SkillFile } from './prompts.ts';
export { SERVER_INSTRUCTIONS } from './server.ts';
